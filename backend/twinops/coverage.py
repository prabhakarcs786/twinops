"""Graph-based slices and explicit adapter capability checks."""

from __future__ import annotations

import heapq
from typing import Any


def path_between(topo: dict, start: str, end: str, *, backup: bool = False, excluded: set[str] | None = None) -> list[str]:
    excluded = excluded or set()
    queue = [(0.0, [start])]
    visited: set[str] = set()
    while queue:
        cost, path = heapq.heappop(queue)
        node = path[-1]
        if node in visited or node in excluded:
            continue
        if node == end:
            return path
        visited.add(node)
        for link in topo["links"]:
            if link.get("backup") and not backup:
                continue
            other = link["b"] if link["a"] == node else link["a"] if link["b"] == node else None
            if other and other not in visited:
                heapq.heappush(queue, (cost + link.get("latencyMs", 1), [*path, other]))
    return []


def select_slice(obs: dict, topo: dict) -> list[str]:
    failed = {p["id"] for p in obs["probes"] if p["kind"] == "journey" and not p["ok"]}
    affected = list(dict.fromkeys(j["from"] for j in topo["journeys"] if j["id"] in failed))
    controls = [n["id"] for n in topo["nodes"] if n["role"] == "pop" and n["id"] not in affected]
    adjacent = next((n for n in controls if any({link["a"], link["b"]} == {n, a} for link in topo["links"] for a in affected)), None)
    starts = [*affected, *([adjacent or controls[0]] if controls else [])]
    dependencies = [n["id"] for n in topo["nodes"] if n["role"] in {"core", "dns", "gateway", "service"}]
    selected = list(dict.fromkeys([*starts, *dependencies]))
    for journey in topo["journeys"]:
        if journey["from"] not in starts:
            continue
        for target in journey.get("dependencies", dependencies):
            path = path_between(topo, journey["from"], target)
            selected.extend(path)
            for transit in path[1:-1]:
                selected.extend(path_between(topo, journey["from"], target, excluded={transit}))
    return list(dict.fromkeys(selected))


def adequacy(obs: dict, topo: dict, selected: list[str], backend: str) -> dict[str, Any]:
    nodes = {n["id"] for n in topo["nodes"]}
    failures = {p["id"] for p in obs["probes"] if p["kind"] == "journey" and not p["ok"]}
    missing: list[str] = []
    journeys = {j["id"]: j for j in topo["journeys"]}
    dependencies = [n["id"] for n in topo["nodes"] if n["role"] in {"dns", "gateway", "service"}]
    for jid in sorted(failures):
        journey = journeys.get(jid)
        if not journey:
            missing.append(f"Unknown affected journey {jid}")
            continue
        for target in journey.get("dependencies", dependencies):
            path = path_between(topo, journey["from"], target)
            if target not in nodes or not path or not set(path).issubset(selected):
                missing.append(f"{jid}: dependency {target} has no represented path")
    # These adapters model one FRR/DNS/TLS service chain. Unsupported inventories are rejected explicitly.
    for identifier in ("B17", "DNS-1", "GW-1", "SVC-1"):
        if identifier not in nodes:
            missing.append(f"Current {backend} adapter cannot represent service-chain resource {identifier}")
    if backend == "emulated" and (len(nodes) != 8 or topo.get("pack") not in {"core", "enterprise"}):
        missing.append("Containerlab adapter has eight declared devices; this topology requires a different lab layout")
    if not failures:
        missing.append("No failing journey was observed")
    return {"schemaVersion": "coverage-1", "adequate": not missing, "missingCritical": missing,
            "affectedJourneys": sorted(failures), "testedJourneys": [j["id"] for j in topo["journeys"] if j["from"] in selected],
            "representedNodes": selected, "totalNodes": len(nodes),
            "capabilities": ["IPv4 routing", "DNS", "TLS", "IPv6 parity"],
            "limitations": ["Physical layer and vendor hardware are not represented", "Convergence and long-lived sessions need separate measurements"]}
