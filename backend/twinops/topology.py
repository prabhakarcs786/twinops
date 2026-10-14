"""One 8-node topology, two label packs. PoP order matters: pop0/pop2 share 10.20.0.0/15, pop3 owns the backup path."""

from __future__ import annotations

from typing import Any, Literal

Pack = Literal["core", "enterprise", "branch"]
Topology = dict[str, Any]

SERVICE_IPS = {"svc.demo": "10.40.0.10", "api.demo": "10.40.0.11"}
SERVICE_IPS_V6 = {"svc.demo": "2001:db8:40::10", "api.demo": "2001:db8:40::11"}
MGMT_PREFIX = "10.99.0.0/16"
SLO_LATENCY_MS = 40
LATENCY_BUDGET_MS = 10

PACKS: dict[str, dict[str, Any]] = {
    "core": {
        "name": "Regional core (synthetic)",
        "pops": [
            {"id": "BER", "label": "Berlin PoP", "short": "BER"},
            {"id": "MUC", "label": "Munich PoP", "short": "MUC"},
            {"id": "HAM", "label": "Hamburg PoP", "short": "HAM"},
            {"id": "FRA", "label": "Frankfurt PoP", "short": "FRA"},
        ],
    },
    "enterprise": {
        "name": "Hybrid enterprise (synthetic)",
        "pops": [
            {"id": "HQ", "label": "Headquarters", "short": "HQ"},
            {"id": "APAC", "label": "Region APAC", "short": "APAC"},
            {"id": "EU", "label": "Region EU", "short": "EU"},
            {"id": "DC", "label": "Data centre", "short": "DC"},
        ],
    },
}

PACKS["branch"] = {"name": "Branch transit topology (synthetic)", "pops": PACKS["core"]["pops"]}


def build_topology(pack: str) -> Topology:
    p0, p1, p2, p3 = PACKS[pack]["pops"]

    def pop(p: dict[str, str], x: int, y: int, octet: int) -> dict[str, Any]:
        return {**p, "role": "pop", "x": x, "y": y, "prefix": f"10.{octet}.0.0/16", "v6Prefix": f"2001:db8:{octet}::/48"}

    nodes = [
        pop(p2, 64, 54, 21),
        pop(p0, 64, 130, 20),
        pop(p3, 64, 206, 23),
        pop(p1, 64, 282, 22),
        {"id": "B17", "label": "Core router B17", "short": "B17", "role": "core", "x": 252, "y": 168},
        {"id": "DNS-1", "label": "Resolver DNS-1", "short": "DNS-1", "role": "dns", "x": 252, "y": 46},
        {"id": "GW-1", "label": "TLS gateway GW-1", "short": "GW-1", "role": "gateway", "x": 404, "y": 168},
        {"id": "SVC-1", "label": "Service SVC-1", "short": "SVC-1", "role": "service", "x": 508, "y": 168},
    ]
    topology = {
        "pack": pack,
        "name": PACKS[pack]["name"],
        "version": f"topo-{pack}-1.0.0",
        "nodes": nodes,
        "links": [
            {"id": "L1", "a": p0["id"], "b": "B17", "latencyMs": 4},
            {"id": "L2", "a": p1["id"], "b": "B17", "latencyMs": 6},
            {"id": "L3", "a": p2["id"], "b": "B17", "latencyMs": 5},
            {"id": "L4", "a": p3["id"], "b": "B17", "latencyMs": 3},
            {"id": "L5", "a": p0["id"], "b": p2["id"], "latencyMs": 3},
            {"id": "L6", "a": p0["id"], "b": p3["id"], "latencyMs": 12, "backup": True},
            {"id": "L7", "a": p1["id"], "b": p3["id"], "latencyMs": 4},
            {"id": "L8", "a": p3["id"], "b": "GW-1", "latencyMs": 12, "backup": True},
            {"id": "L9", "a": "B17", "b": "GW-1", "latencyMs": 2},
            {"id": "L10", "a": "B17", "b": "DNS-1", "latencyMs": 1},
            {"id": "L11", "a": "GW-1", "b": "SVC-1", "latencyMs": 1},
        ],
        "journeys": [
            {"id": "J1", "label": f"{p0['short']} customers → svc.demo", "from": p0["id"], "host": "svc.demo"},
            {"id": "J2", "label": f"{p1['short']} customers → api.demo", "from": p1["id"], "host": "api.demo"},
            {"id": "J3", "label": f"{p2['short']} customers → svc.demo", "from": p2["id"], "host": "svc.demo"},
            {"id": "J4", "label": f"{p3['short']} customers → api.demo", "from": p3["id"], "host": "api.demo"},
        ],
    }
    if pack == "branch":
        topology["nodes"].append(pop({"id": "BRANCH", "label": "Branch office", "short": "BR"}, 150, 310, 24))
        topology["links"] = [link for link in topology["links"] if link["id"] != "L1"]
        topology["links"].append({"id": "L12", "a": "BRANCH", "b": p1["id"], "latencyMs": 3})
        topology["links"].append({"id": "L13", "a": p0["id"], "b": p1["id"], "latencyMs": 6})
        topology["journeys"].append({"id": "J5", "label": "Branch customers → svc.demo", "from": "BRANCH", "host": "svc.demo"})
    return topology


def pops(topo: Topology) -> list[dict[str, Any]]:
    return [n for n in topo["nodes"] if n["role"] == "pop"]


def node_by_id(topo: Topology, node_id: str) -> dict[str, Any] | None:
    return next((n for n in topo["nodes"] if n["id"] == node_id), None)


def pop_by_index(topo: Topology, index: int) -> dict[str, Any]:
    """PoP order as declared in the pack (pop0..pop3), independent of drawing order."""
    return node_by_id(topo, topo["journeys"][index]["from"])  # type: ignore[return-value]


def find_link(topo: Topology, a: str, b: str) -> dict[str, Any] | None:
    return next((link for link in topo["links"] if (link["a"] == a and link["b"] == b) or (link["a"] == b and link["b"] == a)), None)


def journey_by_id(topo: Topology, journey_id: str) -> dict[str, Any]:
    return next(j for j in topo["journeys"] if j["id"] == journey_id)
