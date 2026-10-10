"""Emulated backends: the demo network and the twin are two isolated Containerlab instances of the same topology."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

from ..catalogue import CATALOGUE, apply_change_set
from ..config import Settings
from ..harness import base_history, fault_records
from ..hashing import hash_of
from ..model import State, healthy_state, modelled_alarms
from ..rng import Rng
from ..topology import Topology, pop_by_index, pops
from ..twin import TwinContext, rollback_state, secondary_failure_target, session_challenge
from .device import LabInstance, now_iso
from .plan import INSTANCES, POPS, container
from .runner import DockerRunner, LabError

LAB_SUPPORTED_CHALLENGES = {"dual_stack", "secondary_failure", "warm_cache", "session_continuity"}


def stable_hash(state: State) -> str:
    return hash_of({k: v for k, v in state.items() if k != "now"})


def lab_healthy(topo: Topology) -> State:
    """Healthy declared state anchored to the real clock (certificates are validated by real TLS stacks)."""
    from ..model import add_minutes

    state = healthy_state(topo)
    state["now"] = now_iso()
    for cert in state["gw"]["certs"].values():
        cert["notAfter"] = add_minutes(state["now"], 30 * 24 * 60)
    return state


def runtime_dir(settings: Settings) -> Path:
    return settings.lab_dir / "runtime"


class LabDemoNetwork:
    """The demo network running as real containers. Agents only receive observe() output."""

    backend = "emulated"

    def __init__(self, inst: LabInstance, topo: Topology, seed: int) -> None:
        self.inst = inst
        self.topo = topo
        self.writes: list[dict[str, Any]] = []
        self._rng = Rng(seed)
        self._declared = lab_healthy(topo)
        self._changes = base_history(topo)
        self._logs: list[dict[str, Any]] = []
        self._hardware: list[dict[str, Any]] = []
        self._baselines: dict[str, float] = {}

    def _record(self, actor: str, summary: str, token: str | None = None) -> None:
        entry: dict[str, Any] = {"seq": len(self.writes) + 1, "actor": actor, "summary": summary}
        if token:
            entry["approvalToken"] = token
        self.writes.append(entry)

    async def prepare(self) -> None:
        """Harness reset: bring the demo network back to healthy and measure real baseline latencies."""
        await self.inst.set_flap(None)
        await self.inst.set_paused(set())
        await self.inst.clear_drift()
        await self.inst.push(self._declared, None)
        probes = [await self.inst.sample(self._declared, j) for j in self.topo["journeys"]]
        bad = [p for p in probes if not p["ok"]]
        if bad:
            raise LabError(f"demo network not healthy after reset: {bad[0]['id']} {bad[0]['detail']}")
        self._baselines = {p["id"]: p["latencyMs"] for p in probes}

    async def inject_fault(self, fault: str) -> None:
        before = copy.deepcopy(self._declared)
        changes, logs, hardware = fault_records(self.topo, fault, self._rng, self._declared)
        self._changes += changes
        self._logs += logs
        self._hardware += hardware
        await self.inst.push(self._declared, before)
        if self._declared["physical"]["flappingLink"]:
            await self.inst.set_flap(2)
        self._record("harness", "fault injected by demo harness (label sealed)")

    async def capture_supported(self) -> State:
        return await self.inst.capture(self._declared)

    async def state_hash(self) -> str:
        return stable_hash(await self.capture_supported())

    async def observe(self) -> dict[str, Any]:
        captured = await self.capture_supported()
        probes = await self.inst.fixed_suite(captured, self.topo["journeys"], pop_by_index(self.topo, 0)["id"])
        modelled = [{**a, "count": 3 if a["id"].startswith("A-J") else 1} for a in modelled_alarms(captured, self.topo, probes)]
        alarms = [*modelled, *self._hardware]
        return {
            "capturedAt": now_iso(),
            "stateHash": stable_hash(captured),
            "probes": probes,
            "alarms": alarms,
            "changes": sorted(self._changes, key=lambda c: c["minutesAgo"]),
            "logs": list(self._logs),
            "rawEventCount": sum(a["count"] for a in alarms),
            "baselines": dict(self._baselines),
        }

    async def probe(self, journey_id: str, family: str) -> dict[str, Any]:
        captured = await self.capture_supported()
        journey = next(j for j in self.topo["journeys"] if j["id"] == journey_id)
        return await self.inst.sample(captured, journey, family=family)

    async def simulate_drift(self) -> None:
        await self.inst.drift()
        self._changes.append({"id": "r-2043", "node": "B17", "minutesAgo": 0, "author": "on-call", "summary": "Interface description edited during incident"})
        self._record("harness", "drift simulated: unrelated edit on B17 (real vtysh change)")

    async def apply_approved(self, cs: dict[str, Any], token: str) -> State:
        current = await self.capture_supported()
        after = apply_change_set(current, cs, self.topo)
        restart = [s["target"] for s in cs["steps"] if s["action"] == "restart_service"]
        await self.inst.push(after, current, restart=restart)
        self._declared = after
        self._record("apply_gateway", f"applied {cs['id']} ({cs['hash'][:12]}) to lab devices", token)
        return current

    async def restore(self, previous: State, token: str) -> None:
        # A previous push may have partially succeeded; declared state cannot describe it.
        await self.inst.push(previous, None)
        self._declared = previous
        self._record("apply_gateway", "rollback executed on lab devices", token)

    async def close(self) -> None:
        await self.inst.set_flap(None)


class EmulatedTwin:
    """Twin instance: captured state is pushed to isolated containers; every candidate and challenge runs real traffic."""

    backend = "emulated"
    supported_actions = {name for name, spec in CATALOGUE.items() if spec.lab_supported}
    supported_challenges = LAB_SUPPORTED_CHALLENGES
    latency_tolerance_ms = 30
    latency_budget_ms = 40

    def __init__(self, inst: LabInstance) -> None:
        self.inst = inst
        self.ctx: TwinContext | None = None
        self.device_state: State | None = None
        self.slice_paused: set[str] = set()
        self.base_hash = ""

    def _edge(self) -> str:
        assert self.ctx
        slice_pops = [n for n in self.ctx.slice if any(p["id"] == n for p in pops(self.ctx.topo))]
        affected = {next(j["from"] for j in self.ctx.topo["journeys"] if j["id"] == a) for a in self.ctx.affected_ids}
        return next((n for n in slice_pops if n not in affected), slice_pops[0])

    async def _goto(self, state: State, restart: list[str] | None = None) -> None:
        await self.inst.push(state, self.device_state, restart=restart)
        self.device_state = state

    async def load(self, ctx: TwinContext) -> None:
        self.ctx = ctx
        await self.inst.set_flap(None)
        await self.inst.set_paused(set())
        self.device_state = None
        await self._goto(ctx.captured)
        topo = ctx.topo
        self.slice_paused = {container(self.inst.instance, POPS[i].container) for i in range(4) if pop_by_index(topo, i)["id"] not in ctx.slice}
        await self.inst.set_paused(self.slice_paused)
        self.base_hash = stable_hash(await self.inst.capture(ctx.captured))

    async def baseline(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        assert self.ctx
        probes = await self.inst.fixed_suite(self.ctx.captured, self.ctx.journeys, self._edge())
        return probes, modelled_alarms(self.ctx.captured, self.ctx.topo, probes)

    async def apply(self, change: dict[str, Any]) -> tuple[State, list[dict[str, Any]]]:
        assert self.ctx
        after = apply_change_set(self.ctx.captured, change, self.ctx.topo)
        await self._goto(after, [s["target"] for s in change["steps"] if s["action"] == "restart_service"])
        fixed = await self.inst.fixed_suite(after, self.ctx.journeys, self._edge(), self.ctx.captured)
        return after, await self._confirm_latency(after, fixed)

    async def _confirm_latency(self, state: State, probes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Real networks jitter. A latency regression only counts if it persists on a quiet, sequential re-measurement
        (median of 3); a single noisy parallel sample must not reject a correct fix."""
        assert self.ctx
        before = {o["id"]: o.get("latencyMs") for o in self.ctx.obs["probes"]}
        out = []
        for p in probes:
            base = before.get(p["id"])
            if p["kind"] == "journey" and p["ok"] and base is not None and (p.get("latencyMs") or 0) - base > self.latency_tolerance_ms:
                journey = next(j for j in self.ctx.journeys if j["id"] == p["id"])
                again = [await self.inst.probe_once(state, journey) for _ in range(3)]
                ok = sorted((a for a in again if a["ok"]), key=lambda a: a["latencyMs"])
                if len(ok) == len(again):
                    median = ok[1]
                    out.append({**median, "detail": f"{median['detail']} (re-measured; first parallel sample {p['latencyMs']} ms)"})
                    continue
            out.append(p)
        return out

    async def challenge(self, kind: str, after: State, change: dict[str, Any], fixed: list[dict[str, Any]]) -> dict[str, Any]:
        from ..twin import CHALLENGE_LABEL

        ctx = self.ctx
        assert ctx
        await self._goto(after)

        def result(ok: bool, detail: str, probes: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
            return {"id": f"CH-{kind}", "kind": kind, "label": CHALLENGE_LABEL[kind], "ok": ok, "soft": False, "detail": detail, "probes": probes, **extra}

        if kind == "dual_stack":
            v6 = [j for j in ctx.journeys if next(p for p in pops(ctx.topo) if p["id"] == j["from"])["v6Prefix"] in ctx.captured["b17"]["v6Prefixes"]]
            probes = [await self.inst.sample(after, j, family="v6", kind="challenge") for j in v6]
            failed = [p for p in probes if not p["ok"]]
            return result(not failed, "; ".join(f"{p['label']}: {p['detail']}" for p in failed) if failed else f"{len(probes)} IPv6 journeys succeed (real AAAA + TLS over IPv6)", probes)
        if kind == "secondary_failure":
            target = secondary_failure_target(ctx, fixed)
            idx = next(i for i in range(4) if pop_by_index(ctx.topo, i)["id"] == target)
            await self.inst.set_paused(self.slice_paused | {container(self.inst.instance, POPS[idx].container)})
            try:
                state = {**copy.deepcopy(after), "failedNodes": [target]}
                probes = [await self.inst.sample(state, j, kind="challenge", probe_id=f"{j['id']}-sf") for j in ctx.journeys if j["from"] != target]
            finally:
                await self.inst.set_paused(self.slice_paused)
            failed = [p for p in probes if not p["ok"]]
            detail = (f"with {target} paused: " + "; ".join(f"{p['label']} — {p['detail']}" for p in failed)) if failed else f"with {target} paused, all remaining journeys succeed"
            return result(not failed, detail, probes, target=target)
        if kind == "warm_cache":
            probes = [await self.inst.sample(after, next(x for x in ctx.topo["journeys"] if x["id"] == jid), warm_cache=True, kind="challenge", probe_id=f"{jid}-warm")
                      for jid in ctx.affected_ids]
            failed = [p for p in probes if not p["ok"]]
            return result(not failed, f"clients behind the caching resolver still fail: {failed[0]['detail']}" if failed else "clients behind the caching resolver recover immediately", probes)
        if kind == "session_continuity":
            return session_challenge(change)
        return result(False, f"{kind} is not executable on the emulated twin", [])

    async def rehearse_rollback(self, after: State, diff: list[dict[str, str]]) -> dict[str, Any]:
        assert self.ctx
        rolled = rollback_state(after, self.ctx.captured, diff)
        await self._goto(rolled)
        restored = stable_hash(await self.inst.capture(rolled))
        return {"rehearsed": True, "matches": restored == self.base_hash, "restoredHash": restored}

    async def close(self) -> None:
        await self.inst.set_paused(set())


async def lab_status(settings: Settings) -> dict[str, Any]:
    runner = DockerRunner()
    expected = {container(i, n) for i in INSTANCES for n in ("b17", "gw1", "svc1", "dns1", "dns2", *(p.container for p in POPS))}
    try:
        states = await runner.inspect_states("clab-twinops-")
    except FileNotFoundError:
        return {"backend": "emulated", "ready": False, "detail": "docker CLI not available"}
    running = {n for n, s in states.items() if s in ("running", "paused")}
    missing = sorted(expected - running)
    return {"backend": "emulated", "ready": not missing,
            "detail": "Containerlab: 2 isolated instances × 9 containers (FRR, CoreDNS, nginx)" if not missing else f"lab not deployed: missing {', '.join(missing[:4])}…"}


async def lab_backends(settings: Settings, topo: Topology, seed: int) -> tuple[LabDemoNetwork, EmulatedTwin]:
    status = await lab_status(settings)
    if not status["ready"]:
        raise LabError(f"{status['detail']} — run `python -m twinops.lab up`")
    runtime = runtime_dir(settings)
    runner = DockerRunner()
    demo = LabDemoNetwork(LabInstance("prod", runtime, topo, runner), topo, seed)
    await demo.prepare()
    return demo, EmulatedTwin(LabInstance("twin", runtime, topo, runner))
