"""Model twin semantics: network state as plain data, probes as pure functions of that state."""

from __future__ import annotations

import copy
from datetime import UTC, datetime, timedelta
from typing import Any

from .hashing import js_round, round1
from .topology import MGMT_PREFIX, SERVICE_IPS, SLO_LATENCY_MS, Topology, find_link, node_by_id, pop_by_index, pops

State = dict[str, Any]
Probe = dict[str, Any]

SIM_NOW = "2026-11-17T09:30:00.000Z"


def parse_iso(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def to_iso(dt: datetime) -> str:
    dt = dt.astimezone(UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def add_minutes(iso: str, minutes: float) -> str:
    return to_iso(parse_iso(iso) + timedelta(minutes=minutes))


def minutes_between(later: str, earlier: str) -> float:
    return (parse_iso(later) - parse_iso(earlier)).total_seconds() / 60


def clone(value: Any) -> Any:
    return copy.deepcopy(value)


def healthy_state(topo: Topology) -> State:
    p0, p1, p2, p3 = (pop_by_index(topo, i) for i in range(4))
    archived = {
        "revision": "r-2041",
        "filterEnabled": True,
        "prefixList": [
            {"seq": 10, "action": "deny", "prefix": MGMT_PREFIX, "note": "management network is never advertised to the edge"},
            {"seq": 100, "action": "permit", "prefix": "10.0.0.0/8", "note": "edge customer ranges"},
        ],
        "v6Prefixes": [p0["v6Prefix"], p1["v6Prefix"], p3["v6Prefix"]],
    }
    b17 = clone(archived)
    # h-77 was a manual hotfix: live on the router, never written to the config archive.
    b17.update({"revision": "r-2041+h-77", "v6Prefixes": [p0["v6Prefix"], p1["v6Prefix"], p2["v6Prefix"], p3["v6Prefix"]], "steered": [], "routingUp": True})
    return {
        "b17": b17,
        "archive": {"r-2041": archived},
        "dns": {
            "active": "primary",
            "primary": dict(SERVICE_IPS),
            "standby": {"svc.demo": SERVICE_IPS["svc.demo"], "api.demo": "10.40.0.7"},
            "cache": dict(SERVICE_IPS),
            "serial": 2026111701,
        },
        "clients": {"hosts": {}, "validateTls": True, "acceptExpired": False},
        "gw": {
            "bindings": {"v4": "c-5a1", "v6": "c-5a1"},
            "certs": {"c-5a1": {"serial": "c-5a1", "notAfter": add_minutes(SIM_NOW, 30 * 24 * 60), "san": ["svc.demo", "api.demo"]}},
            "up": True,
        },
        "physical": {"flappingLink": None},
        "failedNodes": [],
        "load": 1,
        "now": SIM_NOW,
        "mgmt": {"adminServiceUp": True},
        "notes": {"B17.description": "core-b17 edge aggregation"},
    }


def capture_supported(state: State) -> State:
    """What the observation service can capture; the physical layer is outside supported fidelity."""
    captured = clone(state)
    captured["physical"] = {"flappingLink": None}
    return captured


def _parse_v4(prefix: str) -> tuple[int, int]:
    ip, length = prefix.split("/")
    n = 0
    for octet in ip.split("."):
        n = ((n << 8) + int(octet)) & 0xFFFFFFFF
    return n, int(length)


def covers(rule_prefix: str, prefix: str) -> bool:
    rn, rl = _parse_v4(rule_prefix)
    pn, pl = _parse_v4(prefix)
    if pl < rl:
        return False
    mask = 0 if rl == 0 else (0xFFFFFFFF << (32 - rl)) & 0xFFFFFFFF
    return (pn & mask) == (rn & mask)


def filter_decision(cfg: dict[str, Any], prefix: str) -> dict[str, Any]:
    if not cfg["filterEnabled"]:
        return {"action": "permit"}
    for rule in sorted(cfg["prefixList"], key=lambda r: r["seq"]):
        if covers(rule["prefix"], prefix):
            return {"action": rule["action"], "rule": rule}
    return {"action": "deny"}


def _backup_path(state: State, topo: Topology, start: str) -> list[str] | None:
    exit_id = pop_by_index(topo, 3)["id"]
    pop_ids = {p["id"] for p in pops(topo)}
    prev: dict[str, str | None] = {start: None}
    queue = [start]
    while queue:
        cur = queue.pop(0)
        if cur == exit_id:
            break
        for link in topo["links"]:
            nxt = link["b"] if link["a"] == cur else link["a"] if link["b"] == cur else None
            if not nxt or nxt not in pop_ids or nxt in prev or nxt in state["failedNodes"]:
                continue
            prev[nxt] = cur
            queue.append(nxt)
    if exit_id not in prev:
        return None
    path: list[str] = []
    n: str | None = exit_id
    while n:
        path.insert(0, n)
        n = prev.get(n)
    return [*path, "GW-1", "SVC-1"]


def effective_answer(state: State, host: str, warm_cache: bool = False) -> str | None:
    if state["clients"]["hosts"].get(host):
        return state["clients"]["hosts"][host]
    if warm_cache and state["dns"]["cache"].get(host):
        return state["dns"]["cache"][host]
    if "DNS-1" in state["failedNodes"] and state["dns"]["active"] == "primary":
        return None
    zone = state["dns"]["primary"] if state["dns"]["active"] == "primary" else state["dns"]["standby"]
    return zone.get(host)


def probe_journey(state: State, topo: Topology, journey: dict[str, Any], *, family: str = "v4", warm_cache: bool = False,
                  sample: int = 0, kind: str = "journey", probe_id: str | None = None, label: str | None = None) -> Probe:
    pop = node_by_id(topo, journey["from"])
    assert pop is not None
    base = {
        "id": probe_id or (f"{journey['id']}-v6" if family == "v6" else journey["id"]),
        "kind": kind,
        "label": label or (f"{pop['short']} IPv6 → {journey['host']}" if family == "v6" else journey["label"]),
    }

    def fail(path: list[str], failed_at: str, failure: str, detail: str) -> Probe:
        return {**base, "ok": False, "path": path, "failedAt": failed_at, "failure": failure, "detail": detail}

    if pop["id"] in state["failedNodes"]:
        return fail([pop["id"]], pop["id"], "node_down", f"{pop['short']} is down (injected condition)")

    flapping = state["physical"]["flappingLink"]
    if flapping:
        link = next((lk for lk in topo["links"] if lk["id"] == flapping), None)
        if link and pop["id"] in (link["a"], link["b"]) and sample in (1, 3):
            return fail([pop["id"], "B17"], "B17", "intermittent", f"packets lost on {link['a']}–{link['b']}")

    ip = effective_answer(state, journey["host"], warm_cache)
    if not ip:
        return fail([pop["id"], "B17", "DNS-1"], "DNS-1", "node_down", f"SERVFAIL resolving {journey['host']}")

    b17 = state["b17"]
    if family == "v4" and pop["prefix"] in b17["steered"]:
        backup = _backup_path(state, topo, pop["id"])
        if not backup:
            return fail([pop["id"]], pop["id"], "no_route", "backup path unavailable")
        path = backup
    else:
        if not b17["routingUp"]:
            return fail([pop["id"], "B17"], "B17", "no_route", "routing process restarting on B17")
        if family == "v4":
            decision = filter_decision(b17, pop["prefix"])
            if decision["action"] == "deny":
                rule = decision.get("rule")
                where = f"seq {rule['seq']}" if rule else "implicit deny"
                return fail([pop["id"], "B17"], "B17", "no_route", f"{pop['prefix']} rejected by EDGE-IN {where} — no return route")
        elif pop["v6Prefix"] not in b17["v6Prefixes"]:
            return fail([pop["id"], "B17"], "B17", "no_route", f"no route for {pop['v6Prefix']}")
        path = [pop["id"], "B17", "GW-1", "SVC-1"]

    for i in range(1, len(path)):
        if path[i] in state["failedNodes"]:
            return fail(path[: i + 1], path[i], "node_down", f"{path[i]} is down (injected condition)")

    to_gateway = path[: path.index("GW-1") + 1]
    if ip != SERVICE_IPS[journey["host"]]:
        return fail(to_gateway, "GW-1", "wrong_address", f"{journey['host']} → {ip}: connection refused (service VIP is not at that address)")
    if not state["gw"]["up"]:
        return fail(to_gateway, "GW-1", "node_down", "gateway restarting")

    serial = state["gw"]["bindings"][family]
    cert = state["gw"]["certs"][serial]
    if state["clients"]["validateTls"]:
        expired_by = minutes_between(state["now"], cert["notAfter"])
        if expired_by > 0 and not state["clients"]["acceptExpired"]:
            return fail(to_gateway, "GW-1", "tls_expired", f"x509: certificate {serial} expired {js_round(expired_by)} min ago ({family} listener)")
        if journey["host"] not in cert["san"]:
            return fail(to_gateway, "GW-1", "tls_name", f"x509: certificate {serial} is not valid for {journey['host']}")

    latency = 2.0
    for i in range(len(path) - 1):
        link = find_link(topo, path[i], path[i + 1])
        assert link is not None
        factor = 1 + (state["load"] - 1) * (0.6 if link.get("backup") else 0.075) if state["load"] > 1 else 1
        latency += link["latencyMs"] * factor
    latency = round1(latency)
    latency_out: int | float = int(latency) if latency.is_integer() else latency
    if latency > SLO_LATENCY_MS:
        return {**base, "ok": False, "path": path, "failedAt": "SVC-1", "failure": "slo_breach", "latencyMs": latency_out,
                "detail": f"{latency_out} ms exceeds {SLO_LATENCY_MS} ms SLO"}
    return {**base, "ok": True, "path": path, "latencyMs": latency_out, "detail": f"HTTP 200 in {latency_out} ms via {' → '.join(path)}"}


def sample_journey(state: State, topo: Topology, journey: dict[str, Any], **opts: Any) -> Probe:
    """Five samples per journey: mixed outcomes are reported as intermittent."""
    samples = [probe_journey(state, topo, journey, sample=s, **opts) for s in range(5)]
    failed = [s for s in samples if not s["ok"]]
    if not failed:
        return samples[0]
    if len(failed) == len(samples):
        return failed[0]
    return {**failed[0], "failure": "intermittent", "detail": f"{len(failed)} of {len(samples)} samples failed — {failed[0]['detail']}"}


def negative_probes(state: State, topo: Topology, baseline: State | None = None) -> list[Probe]:
    edge = pop_by_index(topo, 0)["id"]
    mgmt = filter_decision(state["b17"], MGMT_PREFIX)
    exposed = mgmt["action"] != "deny"
    validation = state["clients"]["validateTls"] and not state["clients"]["acceptExpired"]
    probes: list[Probe] = [
        _drop_none({
            "id": "NEG-1", "kind": "negative", "label": "Untrusted edge → admin port stays blocked", "ok": not exposed,
            "path": [edge, "B17"], "failedAt": "B17" if exposed else None, "failure": "exposed" if exposed else None,
            "detail": f"{MGMT_PREFIX}:22 reachable from the untrusted edge — management prefix leaked" if exposed
            else f"blocked by EDGE-IN seq {mgmt['rule']['seq'] if mgmt.get('rule') else 'implicit'}",
        }),
        _drop_none({
            "id": "NEG-2", "kind": "negative", "label": "Clients reject an expired test certificate", "ok": validation,
            "path": [edge, "GW-1"], "failedAt": None if validation else "GW-1", "failure": None if validation else "validation_off",
            "detail": "handshake refused as expected" if validation else "expired test certificate was ACCEPTED by clients",
        }),
        _drop_none({
            "id": "CTRL-1", "kind": "control", "label": "Positive control: admin service exists for trusted operators",
            "ok": state["mgmt"]["adminServiceUp"], "path": ["B17"], "failure": None if state["mgmt"]["adminServiceUp"] else "control_missing",
            "detail": "reachable from the trusted management host" if state["mgmt"]["adminServiceUp"] else "protected service missing — negative test would be vacuous",
        }),
    ]
    if baseline is not None:
        changed = []
        for host in SERVICE_IPS:
            before = effective_answer(baseline, host)
            if before != SERVICE_IPS[host]:
                continue
            after = effective_answer(state, host)
            if after != before:
                changed.append(f"{host}: {before} → {after or 'no answer'}")
        probes.insert(2, _drop_none({
            "id": "NEG-3", "kind": "negative", "label": "Unaffected DNS answers unchanged", "ok": not changed, "path": ["DNS-1"],
            "failedAt": "DNS-1" if changed else None, "failure": "record_changed" if changed else None,
            "detail": "; ".join(changed) if changed else "all previously correct answers identical",
        }))
    return probes


def _drop_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def fixed_suite(state: State, topo: Topology, journeys: list[dict[str, Any]], baseline: State | None = None) -> list[Probe]:
    return [*(sample_journey(state, topo, j) for j in journeys), *negative_probes(state, topo, baseline)]


def modelled_alarms(state: State, topo: Topology, probes: list[Probe]) -> list[dict[str, Any]]:
    """Device alarms the twin can also produce."""
    alarms: list[dict[str, Any]] = []
    for p in probes:
        if p["kind"] != "journey" or p["ok"] or p.get("failure") == "intermittent":
            continue
        alarms.append({"id": f"A-{p['id']}", "node": p["path"][0], "severity": "major", "text": f"{p['label']}: {p['detail']}",
                       "count": 1, "modelled": True, "cls": f"journey:{p['id']}:{p.get('failure')}"})
    for pop in pops(topo):
        decision = filter_decision(state["b17"], pop["prefix"])
        if decision["action"] == "deny" and decision.get("rule"):
            alarms.append({"id": f"A-B17-{pop['id']}", "node": "B17", "severity": "critical",
                           "text": f"RIB: {pop['prefix']} rejected by prefix-list EDGE-IN seq {decision['rule']['seq']}",
                           "count": 1, "modelled": True, "cls": f"b17:prefix_rejected:{pop['prefix']}"})
    # Handshake alarms are traffic-driven: a listener without failing monitored traffic stays silent.
    tls_failures = [p for p in probes if p["kind"] == "journey" and p.get("failure") == "tls_expired"]
    if tls_failures:
        cert = state["gw"]["certs"][state["gw"]["bindings"]["v4"]]
        alarms.append({"id": "A-GW-v4", "node": "GW-1", "severity": "critical",
                       "text": f"TLS v4 listener: {len(tls_failures)} journeys failing handshake — certificate {cert['serial']} notAfter {cert['notAfter'][11:16]} UTC",
                       "count": 1, "modelled": True, "cls": "gw:cert_expired:v4"})
    return alarms
