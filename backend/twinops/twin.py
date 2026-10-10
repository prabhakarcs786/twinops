"""Twin slice selection, reproduction, experiments, challenges and the deterministic Proof Gate."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from .catalogue import (
    MAX_BLAST_RADIUS,
    apply_change_set,
    diff_states,
    forbidden_reasons,
    required_challenges,
    session_impact,
    touched_nodes,
    validate_change_set,
)
from .hashing import hash_of, round1
from .model import State, clone, fixed_suite, modelled_alarms, probe_journey
from .planner.base import CHALLENGES
from .topology import LATENCY_BUDGET_MS, Topology, node_by_id, pop_by_index, pops

CHALLENGE_LABEL = {
    "dual_stack": "IPv6 / dual-stack parity",
    "secondary_failure": "Secondary node failure",
    "surge_x3": "Traffic surge ×3",
    "warm_cache": "Warm-cache clients (TTL 3600 s)",
    "session_continuity": "Session continuity",
}


@dataclass
class TwinContext:
    topo: Topology
    obs: dict[str, Any]
    captured: State
    slice: list[str]
    journeys: list[dict[str, Any]]
    affected_ids: list[str]


def select_slice(obs: dict[str, Any], topo: Topology) -> list[str]:
    failing = [next(j for j in topo["journeys"] if j["id"] == p["id"]) for p in obs["probes"] if p["kind"] == "journey" and not p["ok"]]
    affected = list(dict.fromkeys(j["from"] for j in failing))
    representatives = affected
    if len(affected) > 2:
        by_host: dict[str, str] = {}
        for j in failing:
            by_host.setdefault(j["host"], j["from"])
        representatives = list(by_host.values())
    unaffected = [p for p in pops(topo) if p["id"] not in affected]
    adjacent = next((p for p in unaffected if any((lk["a"] == p["id"] and lk["b"] in affected) or (lk["b"] == p["id"] and lk["a"] in affected)
                                                  for lk in topo["links"])), None)
    control = [adjacent["id"]] if adjacent else [unaffected[0]["id"]] if unaffected else []
    return [*representatives, *control, "B17", "DNS-1", "GW-1", "SVC-1"]


def create_context(obs: dict[str, Any], topo: Topology, captured: State) -> TwinContext:
    sl = select_slice(obs, topo)
    journeys = [j for j in topo["journeys"] if j["from"] in sl]
    affected = [p["id"] for p in obs["probes"] if p["kind"] == "journey" and not p["ok"] and any(j["id"] == p["id"] for j in journeys)]
    return TwinContext(topo, obs, captured, sl, journeys, affected)


class Twin(Protocol):
    backend: str
    supported_actions: set[str]
    supported_challenges: set[str]

    async def load(self, ctx: TwinContext) -> None: ...
    async def baseline(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]: ...
    async def apply(self, change: dict[str, Any]) -> tuple[State, list[dict[str, Any]]]: ...
    async def challenge(self, kind: str, after: State, change: dict[str, Any], fixed: list[dict[str, Any]]) -> dict[str, Any]: ...
    async def rehearse_rollback(self, after: State, diff: list[dict[str, str]]) -> dict[str, Any]: ...
    async def close(self) -> None: ...


def secondary_failure_target(ctx: TwinContext, fixed: list[dict[str, Any]]) -> str:
    pop_ids = {p["id"] for p in pops(ctx.topo)}
    transit = next((n for p in fixed for n in p["path"][1:] if n in pop_ids), None)
    exit_id = pop_by_index(ctx.topo, 3)["id"]
    if transit:
        return transit
    return exit_id if exit_id in ctx.slice else next(n for n in ctx.slice if n in pop_ids)


def rollback_state(after: State, captured: State, diff: list[dict[str, str]]) -> State:
    rolled = clone(after)
    for section in ("b17", "dns", "clients", "gw", "notes"):
        if any(d["path"].startswith(f"{section}.") for d in diff):
            rolled[section] = clone(captured[section])
    return rolled


def _result(kind: str, ok: bool, detail: str, probes: list[dict[str, Any]], soft: bool = False) -> dict[str, Any]:
    return {"id": f"CH-{kind}", "kind": kind, "label": CHALLENGE_LABEL[kind], "ok": ok, "soft": soft, "detail": detail, "probes": probes}


def session_challenge(change: dict[str, Any]) -> dict[str, Any]:
    impact = session_impact(change)
    if impact == "none":
        return _result("session_continuity", True, "no session-affecting process change", [])
    detail = "process restart resets every active session on the target" if impact == "reset" else "graceful reload drains long-lived sessions (clients re-handshake)"
    return _result("session_continuity", False, detail, [], soft=True)


class ModelTwin:
    """In-process twin: pure functions of captured state. Deterministic, runs anywhere (Cloud Run)."""

    backend = "model"
    supported_actions = set()  # filled in __init__
    supported_challenges = set(CHALLENGES)

    def __init__(self) -> None:
        from .catalogue import CATALOGUE

        self.supported_actions = set(CATALOGUE)
        self.ctx: TwinContext | None = None

    async def load(self, ctx: TwinContext) -> None:
        self.ctx = ctx

    async def baseline(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        assert self.ctx
        probes = fixed_suite(self.ctx.captured, self.ctx.topo, self.ctx.journeys)
        return probes, modelled_alarms(self.ctx.captured, self.ctx.topo, probes)

    async def apply(self, change: dict[str, Any]) -> tuple[State, list[dict[str, Any]]]:
        assert self.ctx
        after = apply_change_set(self.ctx.captured, change, self.ctx.topo)
        return after, fixed_suite(after, self.ctx.topo, self.ctx.journeys, self.ctx.captured)

    async def challenge(self, kind: str, after: State, change: dict[str, Any], fixed: list[dict[str, Any]]) -> dict[str, Any]:
        ctx = self.ctx
        assert ctx
        topo = ctx.topo
        if kind == "dual_stack":
            v6 = [j for j in ctx.journeys if node_by_id(topo, j["from"])["v6Prefix"] in ctx.captured["b17"]["v6Prefixes"]]  # type: ignore[index]
            probes = [probe_journey(after, topo, j, family="v6", kind="challenge") for j in v6]
            failed = [p for p in probes if not p["ok"]]
            return _result(kind, not failed, "; ".join(f"{p['label']}: {p['detail']}" for p in failed) if failed else f"{len(probes)} IPv6 journeys succeed", probes)
        if kind == "secondary_failure":
            target = secondary_failure_target(ctx, fixed)
            state = {**clone(after), "failedNodes": [target]}
            probes = [probe_journey(state, topo, j, kind="challenge", probe_id=f"{j['id']}-sf") for j in ctx.journeys if j["from"] != target]
            failed = [p for p in probes if not p["ok"]]
            detail = (f"with {target} down: " + "; ".join(f"{p['label']} — {p['detail']}" for p in failed)) if failed else f"with {target} down, all remaining journeys succeed"
            return {**_result(kind, not failed, detail, probes), "target": target}
        if kind == "surge_x3":
            state = {**clone(after), "load": 3}
            probes = [probe_journey(state, topo, j, kind="challenge", probe_id=f"{j['id']}-surge") for j in ctx.journeys]
            failed = [p for p in probes if not p["ok"]]
            worst = max((p.get("latencyMs", 0) for p in probes), default=0)
            return _result(kind, not failed, "; ".join(f"{p['label']}: {p['detail']}" for p in failed) if failed else f"worst latency {worst} ms under ×3 load", probes)
        if kind == "warm_cache":
            probes = [probe_journey(after, topo, next(x for x in topo["journeys"] if x["id"] == jid), warm_cache=True, kind="challenge", probe_id=f"{jid}-warm")
                      for jid in ctx.affected_ids]
            failed = [p for p in probes if not p["ok"]]
            return _result(kind, not failed, f"clients with cached answers still fail: {failed[0]['detail']}" if failed else "clients with warm caches recover immediately", probes)
        return session_challenge(change)

    async def rehearse_rollback(self, after: State, diff: list[dict[str, str]]) -> dict[str, Any]:
        assert self.ctx
        restored = hash_of(rollback_state(after, self.ctx.captured, diff))
        return {"rehearsed": True, "matches": restored == hash_of(self.ctx.captured), "restoredHash": restored}

    async def close(self) -> None:
        return None


async def reproduce(ctx: TwinContext, twin: Twin) -> dict[str, Any]:
    twin_probes, twin_alarms = await twin.baseline()
    journeys = {j["id"] for j in ctx.journeys}
    relevant = [p for p in ctx.obs["probes"] if p["kind"] != "journey" or p["id"] in journeys]
    mismatches: list[str] = []
    matched = total = 0
    for prod in relevant:
        tw = next((t for t in twin_probes if t["id"] == prod["id"]), None)
        total += 1
        same = tw is not None and tw["ok"] == prod["ok"] and (prod["ok"] or tw.get("failure") == prod.get("failure"))
        if same:
            matched += 1
        else:
            twin_state = "missing" if tw is None else "ok" if tw["ok"] else tw.get("failure")
            mismatches.append(f"{prod['id']}: production {'ok' if prod['ok'] else prod.get('failure')}, twin {twin_state}")
    twin_classes = {a["cls"] for a in twin_alarms}
    for alarm in (a for a in ctx.obs["alarms"] if a["modelled"] and a["node"] in ctx.slice):
        total += 1
        if alarm["cls"] in twin_classes:
            matched += 1
        else:
            mismatches.append(f"{alarm['id']}: alarm not reproduced")

    def affected_ok(jid: str) -> bool:
        prod = next(p for p in ctx.obs["probes"] if p["id"] == jid)
        tw = next((t for t in twin_probes if t["id"] == jid), None)
        return bool(tw) and not tw["ok"] and tw.get("failure") == prod.get("failure")  # type: ignore[index]

    affected_reproduced = all(affected_ok(j) for j in ctx.affected_ids)
    return {
        "matched": matched, "total": total, "affectedReproduced": affected_reproduced,
        "passed": affected_reproduced and total > 0 and matched / total >= 0.9,
        "mismatches": mismatches, "outOfScope": [f"{a['node']}: {a['text']}" for a in ctx.obs["alarms"] if not a["modelled"]],
        "slice": ctx.slice, "twinProbes": twin_probes,
    }


@dataclass
class Experiment:
    change: dict[str, Any]
    errors: list[str]
    after: State
    diff: list[dict[str, str]]
    touched: list[str]
    fixed: list[dict[str, Any]]
    restored: bool
    regressions: list[dict[str, Any]]
    latency_delta_ms: float
    forbidden: list[str]
    rollback: dict[str, Any] = field(default_factory=dict)
    latency_budget_ms: float = LATENCY_BUDGET_MS
    supported_challenges: set[str] = field(default_factory=lambda: set(CHALLENGES))


async def run_experiment(ctx: TwinContext, twin: Twin, change: dict[str, Any]) -> Experiment:
    errors = validate_change_set(change, twin.supported_actions)
    if errors:
        return Experiment(change, errors, clone(ctx.captured), [], [], [], False, [], 0, [],
                          {"rehearsed": False, "matches": False, "restoredHash": ""})
    after, fixed = await twin.apply(change)
    restored = all(next((p for p in fixed if p["id"] == jid), {}).get("ok", False) for jid in ctx.affected_ids)

    def is_regression(p: dict[str, Any]) -> bool:
        if p["id"] in ctx.affected_ids:
            return False
        if not p["ok"]:
            return True
        before = next((o for o in ctx.obs["probes"] if o["id"] == p["id"]), None)
        tolerance = getattr(twin, "latency_tolerance_ms", 5)
        return p["kind"] == "journey" and before is not None and before.get("latencyMs") is not None and (p.get("latencyMs") or 0) - before["latencyMs"] > tolerance

    regressions = [p for p in fixed if is_regression(p)]
    for p in regressions:
        before = next((o for o in ctx.obs["probes"] if o["id"] == p["id"]), None)
        if p["ok"] and before is not None:
            p["baselineMs"] = before.get("latencyMs")
    deltas = [(next((p for p in fixed if p["id"] == jid), {}).get("latencyMs") or 0) - ctx.obs["baselines"].get(jid, 0) for jid in ctx.affected_ids]
    delta = round1(max(deltas)) if restored and deltas else 0
    delta = int(delta) if float(delta).is_integer() else delta
    diff = diff_states(ctx.captured, after)
    exp = Experiment(change, [], after, diff, touched_nodes(change, ctx.topo), fixed, restored, regressions, delta, forbidden_reasons(change),
                     {"rehearsed": False, "matches": False, "restoredHash": ""})
    exp.latency_budget_ms = getattr(twin, "latency_budget_ms", LATENCY_BUDGET_MS)
    exp.supported_challenges = twin.supported_challenges
    return exp


def regression_text(p: dict[str, Any]) -> str:
    """A probe that still succeeds but got slower is a latency regression; say so instead of quoting its success detail."""
    if p["ok"] and p.get("baselineMs") is not None:
        return f"{p['id']} latency regression: {p.get('latencyMs')} ms vs {p['baselineMs']} ms before the change"
    return f"{p['id']} {p['detail']}"


def evaluate_gates(repro: dict[str, Any], exp: Experiment, challenges: list[dict[str, Any]] | None) -> dict[str, Any]:
    gates: list[dict[str, Any]] = []
    reasons: list[str] = []

    def add(gid: str, status: str, reason: str) -> None:
        gates.append({"id": gid, "status": status, "reason": reason})
        if status == "fail":
            reasons.append(f"{gid}: {reason}")

    if repro["passed"]:
        add("G1", "pass", f"{repro['matched']}/{repro['total']} symptoms reproduced in twin")
    else:
        add("G1", "fail", "fault not reproduced — no fix can be trusted")

    still = [p for p in exp.fixed if not p["ok"] and p not in exp.regressions and p["kind"] == "journey"]
    if exp.restored:
        add("G2", "pass", "every affected journey succeeds in the twin")
    elif exp.errors:
        add("G2", "fail", "not executed — malformed change set")
    else:
        add("G2", "fail", f"{', '.join(p['id'] for p in still)} still failing: {still[0]['detail'] if still else ''}")

    if exp.regressions:
        add("G3", "fail", "; ".join(regression_text(p) for p in exp.regressions))
    else:
        add("G3", "pass", "unaffected journeys, negative tests and positive control unchanged")

    if challenges is None and exp.restored and not exp.regressions and not exp.forbidden and not exp.errors:
        add("G4", "fail", "required challenge evidence missing: candidate was not attacked")
    elif challenges is None:
        add("G4", "skip", "not attacked — an earlier gate already failed")
    else:
        hard = [c for c in challenges if not c["ok"] and not c["soft"]]
        missing = [] if exp.errors else [k for k in required_challenges(exp.change)
                                         if k in exp.supported_challenges and not any(c["kind"] == k for c in challenges)]
        if missing:
            add("G4", "fail", f"required challenge evidence missing: {', '.join(missing)}")
        elif hard:
            add("G4", "fail", "; ".join(f"{c['label']}: {c['detail']}" for c in hard))
        else:
            add("G4", "pass", f"survived {len(challenges)} challenges")

    if exp.errors:
        add("G5", "fail", f"schema validation: {'; '.join(exp.errors)}")
    elif exp.forbidden:
        add("G5", "fail", " ".join(exp.forbidden))
    elif len(exp.touched) > MAX_BLAST_RADIUS:
        add("G5", "fail", f"blast radius {len(exp.touched)} nodes exceeds {MAX_BLAST_RADIUS}")
    else:
        add("G5", "pass", f"allowed action · blast radius {len(exp.touched)} node{'' if len(exp.touched) == 1 else 's'}")

    if exp.rollback.get("rehearsed") and exp.rollback.get("matches"):
        add("G6", "pass", "rollback rehearsed in twin — state hash restored")
    else:
        add("G6", "fail", "rollback did not restore the captured state" if exp.rollback.get("rehearsed") else "rollback not rehearsed")

    warnings = [w for w in [
        f"+{exp.latency_delta_ms} ms latency over baseline (budget {exp.latency_budget_ms} ms)" if exp.latency_delta_ms > exp.latency_budget_ms else "",
        *(f"{c['label']}: {c['detail']}" for c in (challenges or []) if not c["ok"] and c["soft"]),
    ] if w]
    gates.append({"id": "G7", "status": "warn", "reason": "; ".join(warnings)} if warnings
                 else {"id": "G7", "status": "pass", "reason": "within latency budget, no session impact"})
    gates.append({"id": "G8", "status": "pending", "reason": "requires a human approval bound to this change hash"})
    failed = any(g["status"] == "fail" for g in gates)
    decision = "rejected" if failed else "pass_with_warnings" if warnings else "pass"
    return {"gates": gates, "decision": decision, "reasons": reasons, "warnings": warnings}
