"""Incident registry: runs investigations as background tasks and fans events out to SSE subscribers."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from .config import Settings
from .engine import new_incident_id, pick_fault
from .harness import FAULT_INFO, ModelDemoNetwork
from .orchestrator import IncidentSession, decide, run_incident
from .planner.factory import build_planner
from .topology import build_topology
from .twin import ModelTwin

log = logging.getLogger("twinops")
TERMINAL = {"closed", "escalated", "failed"}


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

    async def notify(self, _event: dict[str, Any] | None = None) -> None:
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

    def active(self) -> int:
        return sum(1 for i in self.incidents.values() if i.session.status == "running")

    async def _backends(self, topo: dict[str, Any], seed: int) -> tuple[Any, Any]:
        if self.settings.twin == "emulated":
            from .lab.backend import lab_backends

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
        self.incidents[session.incident_id] = live
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
        if live.session.status != "awaiting_approval":
            raise ValueError(f"incident is {live.session.status}, not awaiting approval")
        live.session.status = "applying"
        try:
            await decide(live.session, operator, comment, decision, emit=live.notify)
        finally:
            await self._close_backends(live)
            await live.notify()

    async def drift(self, live: LiveIncident) -> None:
        if live.session.status != "awaiting_approval":
            raise ValueError("drift can only be simulated while awaiting approval")
        await live.session.demo.simulate_drift()

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
        for live in self.incidents.values():
            if live.task and not live.task.done():
                live.task.cancel()
            if not live.finished:
                await self._close_backends(live)
