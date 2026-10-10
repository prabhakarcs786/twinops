"""Incident registry: runs investigations as background tasks and fans events out to SSE subscribers."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .config import Settings
from .engine import new_incident_id, pick_fault
from .harness import FAULT_INFO, ModelDemoNetwork
from .orchestrator import IncidentSession, decide, idle_frame, qa_context, run_incident
from .planner.factory import build_planner
from .planner.runbook import RunbookPlanner
from .store import IncidentStore
from .topology import build_topology
from .twin import ModelTwin

log = logging.getLogger("twinops")
TERMINAL = {"closed", "escalated", "failed", "recovery_required"}


class BusyError(RuntimeError):
    pass


@dataclass
class LiveIncident:
    session: IncidentSession
    topo: dict[str, Any]
    seed: int
    created: float = field(default_factory=time.time)
    changed: asyncio.Condition = field(default_factory=asyncio.Condition)
    task: asyncio.Task[Any] | None = None
    error: str | None = None
    recovered: bool = False
    persist: Callable[[], None] | None = None

    async def notify(self, _event: dict[str, Any] | None = None) -> None:
        if self.persist:
            self.persist()
        async with self.changed:
            self.changed.notify_all()

    @property
    def finished(self) -> bool:
        return self.session.status in TERMINAL


class Registry:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.incidents: dict[str, LiveIncident] = {}
        self._lab_lock = asyncio.Lock()
        self._lab: Any = None
        self.store = IncidentStore(settings.data_dir)
        # A process restart cannot establish the state of a formerly live target.
        for record in self.store.unfinished():
            applying = record["status"] == "applying"
            record["status"] = "recovery_required" if applying else "closed"
            record["outcome"] = {
                "status": "recovery_required" if applying else "expired",
                "reason": "Service restarted during apply; target state is unknown. Operator recovery required." if applying
                else "Service restarted. Evidence retained; approval invalidated. Start a new investigation to re-observe the target.",
                "postChecks": [],
            }
            prior = record["events"][-1] if record["events"] else None
            record["events"].append({"seq": prior["seq"] + 1 if prior else 1, "at": prior["at"] if prior else 0,
                                     "kind": "recovery_required" if applying else "run_failed", "phase": "apply" if applying else "gate",
                                     "actor": "harness", "tone": "fail" if applying else "warn",
                                     "title": "Operator recovery required" if applying else "Investigation interrupted by service restart",
                                     "summary": record["outcome"]["reason"], "raw": None,
                                     "frame": prior["frame"] if prior else idle_frame(record["topology"])})
            self.store.save(record)

    def _persist(self, live: LiveIncident) -> None:
        s = live.session
        self.store.save({"id": s.incident_id, "created": live.created, "seed": live.seed, "topology": live.topo,
                         "sealedFault": s.sealed_fault, "backend": s.demo.backend, "status": s.status,
                         "run": {k: v for k, v in s.run.items() if k != "events"}, "events": s.events,
                         "approval": s.approval, "outcome": s.outcome, "narrative": s.narrative, "writes": s.demo.writes, "error": live.error})

    def get(self, incident_id: str) -> LiveIncident | None:
        if incident_id in self.incidents:
            return self.incidents[incident_id]
        record = self.store.get(incident_id)
        if record is None:
            return None
        # Archived evidence has no live device handles or model calls, and cannot be approved.
        demo = ModelDemoNetwork(record["topology"], record["seed"])
        demo.writes = record["writes"]
        demo.backend = record["backend"]
        session = IncidentSession(incident_id=incident_id, sealed_fault=record["sealedFault"], demo=demo, twin=ModelTwin(),
                                  planner=RunbookPlanner(), pace=0, run=record["run"], events=record["events"],
                                  approval=record["approval"], outcome=record["outcome"], narrative=record["narrative"], status=record["status"])
        if session.run:
            session.run["events"] = session.events
        return LiveIncident(session=session, topo=record["topology"], seed=record["seed"], created=record["created"],
                            error=record["error"], recovered=True)

    def history(self) -> list[dict[str, Any]]:
        return [{"incidentId": r["id"], "createdAt": r["created"], "seed": r["seed"], "status": r["status"],
                 "pack": r["run"].get("pack", r["topology"]["pack"]), "verdict": r["run"].get("verdict"),
                 "outcome": (r["outcome"] or {}).get("status"), "planner": r["run"].get("planner")}
                for r in self.store.recent()]

    def active(self) -> int:
        return sum(1 for i in self.incidents.values() if i.session.status == "running")

    async def _backends(self, topo: dict[str, Any], seed: int) -> tuple[Any, Any]:
        if self.settings.twin == "emulated":
            from .lab.backend import lab_backends

            if self.store.needs_recovery():
                raise BusyError("a previous apply needs operator recovery; inspect the retained evidence before reusing the lab")
            if self._lab_lock.locked():
                raise BusyError("the emulated lab is serving another incident; try again when it finishes")
            await self._lab_lock.acquire()
            try:
                return await lab_backends(self.settings, topo, seed)
            except Exception:
                self._lab_lock.release()
                raise
        return ModelDemoNetwork(topo, seed), ModelTwin()

    def _release_lab(self) -> None:
        if self.settings.twin == "emulated" and self._lab_lock.locked():
            self._lab_lock.release()

    async def create(self, pack: str, fault: str, seed: int | None, pace: float, include_evaluation_case: bool) -> LiveIncident:
        if self.active() >= self.settings.max_active_runs:
            raise BusyError("too many investigations in progress")
        seed = seed if seed is not None else secrets.randbelow(100_000)
        topo = build_topology(pack)
        demo, twin = await self._backends(topo, seed)
        session = IncidentSession(incident_id=new_incident_id(), sealed_fault=pick_fault(fault, seed), demo=demo, twin=twin,
                                  planner=build_planner(settings=self.settings), pace=pace)
        live = LiveIncident(session=session, topo=topo, seed=seed)
        live.persist = lambda: self._persist(live)
        self.incidents[session.incident_id] = live
        self._persist(live)
        self._evict()
        live.task = asyncio.create_task(self._run(live, include_evaluation_case))
        return live

    async def _run(self, live: LiveIncident, include_evaluation_case: bool) -> None:
        try:
            await run_incident(live.session, live.topo, live.seed, emit=live.notify, include_evaluation_case=include_evaluation_case)
        except Exception as exc:  # noqa: BLE001 — a failed run must surface as INCONCLUSIVE, never as a green result
            log.exception("incident %s failed", live.session.incident_id)
            live.error = f"{type(exc).__name__}: {str(exc)[:200]}"
            live.session.status = "failed"
            prior = live.session.events[-1] if live.session.events else None
            live.session.events.append({
                "seq": (prior["seq"] + 1) if prior else 1, "at": prior["at"] if prior else 0, "kind": "run_failed", "phase": prior["phase"] if prior else "break",
                "actor": "harness", "tone": "fail", "title": "Run stopped — INCONCLUSIVE", "summary": f"The investigation failed: {live.error}. Nothing was applied.",
                "raw": {"error": live.error}, "frame": {**(prior["frame"] if prior else {}), "verdict": "INCONCLUSIVE"},
            })
        finally:
            if live.session.status in ("escalated", "failed"):
                await self._close_backends(live)
            elif live.session.status == "awaiting_approval":
                asyncio.get_running_loop().call_later(self.settings_approval_ttl, lambda: asyncio.ensure_future(self._expire(live)))
            await live.notify()

    settings_approval_ttl = 900.0

    async def _expire(self, live: LiveIncident) -> None:
        """An unanswered approval expires so the lab is not held forever; nothing is applied."""
        if live.session.status != "awaiting_approval":
            return
        live.session.status = "closed"
        live.session.outcome = {"status": "expired", "reason": "approval window expired — nothing applied", "postChecks": []}
        await self._close_backends(live)
        await live.notify()

    async def _close_backends(self, live: LiveIncident) -> None:
        with contextlib.suppress(Exception):
            await live.session.twin.close()
        with contextlib.suppress(Exception):
            await live.session.demo.close()
        self._release_lab()

    async def decide(self, live: LiveIncident, operator: str, comment: str, decision: str) -> None:
        if live.recovered or live.session.status != "awaiting_approval":
            raise ValueError(f"incident is {live.session.status}, not awaiting approval")
        live.session.status = "applying"
        try:
            await live.notify()
            await decide(live.session, operator, comment, decision, emit=live.notify)
        except (Exception, asyncio.CancelledError):
            # Cancellation and event/storage failures may escape the apply gateway.
            # Keep the target quarantined until an operator establishes its state.
            if live.session.status == "applying":
                live.session.status = "recovery_required"
                live.session.outcome = {"status": "recovery_required", "reason": "Apply interrupted; target state could not be verified. Operator recovery required.", "postChecks": []}
                prior = live.session.events[-1]
                live.session.events.append({"seq": prior["seq"] + 1, "at": prior["at"], "kind": "recovery_required", "phase": "apply",
                                            "actor": "apply", "tone": "fail", "title": "Operator recovery required",
                                            "summary": live.session.outcome["reason"], "raw": None, "frame": prior["frame"]})
            raise
        finally:
            if live.session.status == "closed":
                await self._close_backends(live)
            await live.notify()

    async def drift(self, live: LiveIncident) -> None:
        if live.session.status != "awaiting_approval":
            raise ValueError("drift can only be simulated while awaiting approval")
        await live.session.demo.simulate_drift()

    async def ask(self, live: LiveIncident, question: str) -> dict[str, Any]:
        if live.recovered:
            raise ValueError("this is archived evidence; model questions require a live incident")
        planner = live.session.planner
        if not hasattr(planner, "answer"):
            raise ValueError("Ask TwinOps needs an LLM planner (configure Gemini, Ollama or an OpenAI-compatible endpoint)")
        if not live.session.run:
            raise ValueError("questions open once the verdict is in")
        return await planner.answer(question, qa_context(live.session.run, live.session.outcome))

    def reveal(self, live: LiveIncident) -> dict[str, str]:
        if live.session.status == "running":
            raise ValueError("the fault stays sealed until the verdict")
        return FAULT_INFO[live.session.sealed_fault]

    def _evict(self, keep: int = 50) -> None:
        if len(self.incidents) <= keep:
            return
        for incident_id, live in sorted(self.incidents.items(), key=lambda kv: kv[1].created):
            if len(self.incidents) <= keep:
                break
            if live.finished:
                del self.incidents[incident_id]

    async def shutdown(self) -> None:
        tasks = []
        for live in self.incidents.values():
            if live.task and not live.task.done():
                live.task.cancel()
                tasks.append(live.task)
            if not live.finished:
                await self._close_backends(live)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
