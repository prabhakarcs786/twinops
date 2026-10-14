"""Bounded hypothesis/probe loop. Its probe catalogue is read-only and selected by policy."""

from __future__ import annotations

from typing import Any

from .evidence import DiagnosticEvidence, collect_diagnostic

PROBES = {
    "edge_filter_regression": ("route_lookup", "direct_ip"),
    "dns_record_incorrect": ("direct_ip", "dns_lookup"),
    "tls_certificate_expired": ("tls_probe", "direct_ip"),
    "physical_link_degradation": ("direct_ip", "route_lookup"),
    "service_unavailable": ("direct_ip", "tls_probe"),
}


async def investigate(network: Any, planner: Any, obs: dict, topo: dict, guarded: list, snapshot: dict, emit: Any,
                      max_probes: int = 4) -> tuple[list, list, dict]:
    port = DiagnosticEvidence()
    rounds = []
    failing = [p for p in obs["probes"] if p["kind"] == "journey" and not p["ok"]]
    hypotheses, _ = await planner.diagnose(obs, topo, port, guarded)
    attempted: set[tuple[str, str]] = set()
    for index in range(max_probes):
        top = hypotheses[0]
        # Probe an affected journey, prioritizing one cited by the leading hypothesis.
        journeys = sorted(failing, key=lambda p: p["id"] not in top["supporting"])
        used_kinds = {x[0] for x in attempted}
        kinds = sorted(PROBES.get(top["type"], ()), key=lambda kind: kind in used_kinds)
        choice = next(((kind, p["id"]) for kind in kinds for p in journeys
                       if (kind, p["id"]) not in attempted), None)
        if choice is None:
            break
        kind, jid = choice
        attempted.add(choice)
        result = await collect_diagnostic(network, kind, jid, snapshot)
        port.items.append(result)
        previous = top["type"]
        hypotheses, _ = await planner.diagnose(obs, topo, port, guarded)
        step = {"round": index + 1, "hypothesisBefore": previous, "hypothesisAfter": hypotheses[0]["type"],
                "question": f"Test {previous.replace('_', ' ')} with {kind.replace('_', ' ')} on {jid}", "evidence": result}
        rounds.append(step)
        await emit(step)
        # The current hypothesis needs its own diagnostic pair, after reranking.
        kinds = {x["diagnostic"] for x in port.items if x["available"]}
        required = set(PROBES.get(hypotheses[0]["type"], ()))
        if required and required <= kinds and previous == hypotheses[0]["type"]:
            break
    available = [x for x in port.items if x["available"]]
    required = set(PROBES.get(hypotheses[0]["type"], ()))
    stable = bool(rounds) and rounds[-1]["hypothesisBefore"] == rounds[-1]["hypothesisAfter"]
    sufficient = bool(failing and required) and required <= {x["diagnostic"] for x in available} and stable
    return hypotheses, port.results(), {"schemaVersion": "investigation-1", "rounds": rounds, "probeBudget": max_probes,
                                       "sufficient": sufficient, "stopReason": "Required diagnostics collected and leading hypothesis stable; twin verification still required."
                                       if sufficient else "Diagnostic coverage incomplete; escalate for more evidence."}
