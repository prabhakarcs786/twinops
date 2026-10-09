"""Factory for incident sessions: wires topology, demo network, twin backend and planner."""

from __future__ import annotations

import secrets
from typing import Any

from .harness import SUPPORTED_FAULTS, ModelDemoNetwork
from .orchestrator import IncidentSession, decide, run_incident
from .planner.runbook import RunbookPlanner
from .topology import build_topology
from .twin import ModelTwin


def new_incident_id() -> str:
    return f"inc-{secrets.token_hex(3)}"


def pick_fault(fault: str, seed: int) -> str:
    return SUPPORTED_FAULTS[seed % len(SUPPORTED_FAULTS)] if fault == "random" else fault


def model_session(pack: str, fault: str, seed: int, planner: Any = None, pace: float = 0, incident_id: str | None = None) -> tuple[IncidentSession, dict[str, Any]]:
    topo = build_topology(pack)
    session = IncidentSession(
        incident_id=incident_id or new_incident_id(),
        sealed_fault=pick_fault(fault, seed),
        demo=ModelDemoNetwork(topo, seed),
        twin=ModelTwin(),
        planner=planner or RunbookPlanner(),
        pace=pace,
    )
    return session, topo


async def run_model(pack: str, fault: str, seed: int, planner: Any = None) -> IncidentSession:
    session, topo = model_session(pack, fault, seed, planner)
    await run_incident(session, topo, seed)
    return session


__all__ = ["decide", "model_session", "new_incident_id", "pick_fault", "run_model"]
