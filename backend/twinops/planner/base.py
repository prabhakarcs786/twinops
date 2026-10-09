"""Planner contract shared by the deterministic runbook and LLM planners."""

from __future__ import annotations

import re
from typing import Any, Protocol

INSTRUCTION_PATTERN = re.compile(r"(ignore (your|previous|all)|system prompt|assistant:|skip the tests|approve this|you are authori[sz]ed)", re.I)

HYPOTHESIS_TYPES: dict[str, str] = {
    "edge_filter_regression": "An edge prefix filter or route policy on the core router rejects customer routes.",
    "dns_record_incorrect": "A DNS record resolves a service name to the wrong address.",
    "tls_certificate_expired": "A TLS certificate on the gateway is expired or invalid for the requested name.",
    "physical_link_degradation": "A physical link is degrading (CRC errors, flaps, packet loss).",
    "service_unavailable": "The application service itself is unavailable.",
}

CHALLENGES: dict[str, str] = {
    "dual_stack": "IPv6 / dual-stack parity: every PoP with a live IPv6 prefix must still reach the service over IPv6.",
    "secondary_failure": "Secondary node failure: take one transit or control PoP down; all remaining journeys must work.",
    "surge_x3": "Traffic surge ×3: journeys must stay within the latency SLO under triple load.",
    "warm_cache": "Warm-cache clients: clients holding cached DNS answers (TTL 3600 s) must recover too.",
    "session_continuity": "Session continuity: does the change reset or drain existing sessions?",
}


def guard_untrusted(logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Logs are data. Instruction-like text is flagged and never reaches tool selection."""
    return [{**log, "flagged": bool(INSTRUCTION_PATTERN.search(log["text"]))} for log in logs]


class DiagnosticPort(Protocol):
    def direct_ip(self, journey_id: str) -> dict[str, Any]: ...


class Planner(Protocol):
    kind: str
    version: str
    mode: str

    async def diagnose(self, obs: dict[str, Any], topo: dict[str, Any], port: DiagnosticPort, guarded_logs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]: ...

    async def propose(self, hyp: dict[str, Any], captured: dict[str, Any], obs: dict[str, Any], topo: dict[str, Any], supported: set[str]) -> list[dict[str, Any]]: ...

    async def select_challenges(self, change: dict[str, Any], supported: set[str]) -> list[str]: ...

    async def revise(self, change: dict[str, Any], failed: list[dict[str, Any]], captured: dict[str, Any], obs: dict[str, Any], topo: dict[str, Any],
                     supported: set[str]) -> dict[str, Any] | None: ...

    async def narrate(self, summary: dict[str, Any]) -> dict[str, Any] | None: ...

    def drain_notes(self) -> list[dict[str, Any]]:
        """Planner-side notes since the last call (LLM latency, tokens, fallbacks, rejected outputs)."""
        ...
