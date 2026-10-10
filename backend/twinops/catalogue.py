"""Typed action catalogue. Planners may only propose these actions; anything else is rejected before execution."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .hashing import js_str, js_stringify, sha256
from .model import State, add_minutes, clone
from .topology import Topology, pop_by_index, pops

CATALOGUE_VERSION = "catalogue-0.1.0"
POLICY_VERSION = "policy-0.1.0"
MAX_BLAST_RADIUS = 2
MAX_STEPS = 3

ChangeSet = dict[str, Any]
Step = dict[str, Any]


@dataclass(frozen=True)
class ActionSpec:
    title: str
    category: str
    targets: tuple[str, ...]
    params: dict[str, str]
    session_impact: str
    apply: Callable[[State, Step, Topology], None]
    description: str
    forbidden: str | None = None
    touched: Callable[[Step, Topology], list[str]] | None = None
    lab_supported: bool = True
    extra: dict[str, Any] = field(default_factory=dict)


def _noop(_s: State, _st: Step, _t: Topology) -> None:
    """Process restarts and reloads the same persisted configuration."""


def _rollback(state: State, step: Step, _t: Topology) -> None:
    archived = state["archive"].get(str(step["params"]["to_revision"]))
    if not archived:
        raise ValueError(f"revision {step['params']['to_revision']} not in archive")
    state["b17"] = {**clone(archived), "steered": state["b17"]["steered"], "routingUp": state["b17"]["routingUp"]}


def _remove_rule(state: State, step: Step, _t: Topology) -> None:
    seq = int(step["params"]["seq"])
    state["b17"]["prefixList"] = [r for r in state["b17"]["prefixList"] if r["seq"] != seq]
    state["b17"]["revision"] = f"{state['b17']['revision'].split('~')[0]}~fix"


def _set_route(state: State, step: Step, _t: Topology) -> None:
    merged = list(dict.fromkeys([*state["b17"]["steered"], *step["params"]["prefixes"]]))
    state["b17"]["steered"] = merged


def _disable_filter(state: State, _st: Step, _t: Topology) -> None:
    state["b17"]["filterEnabled"] = False


def _flush(state: State, step: Step, _t: Topology) -> None:
    names = step["params"]["names"]
    if not names:
        state["dns"]["cache"] = {}
    for name in names:
        state["dns"]["cache"].pop(name, None)


def _switch(state: State, step: Step, _t: Topology) -> None:
    state["dns"]["active"] = "standby" if step["params"]["to"] == "standby" else "primary"


def _restore(state: State, step: Step, _t: Topology) -> None:
    state["dns"]["primary"][str(step["params"]["host"])] = str(step["params"]["value"])
    state["dns"]["serial"] += 1


def _hosts(state: State, step: Step, _t: Topology) -> None:
    state["clients"]["hosts"][str(step["params"]["host"])] = str(step["params"]["value"])


def _renew(state: State, step: Step, _t: Topology) -> None:
    serial = f"c-{sha256(js_stringify(step['params']) + state['now'])[:3]}"
    state["gw"]["certs"][serial] = {"serial": serial, "notAfter": add_minutes(state["now"], 90 * 24 * 60), "san": list(step["params"]["san"])}
    for listener in step["params"]["listeners"]:
        if listener in ("v4", "v6"):
            state["gw"]["bindings"][listener] = serial


def _trust(state: State, step: Step, _t: Topology) -> None:
    state["clients"]["acceptExpired"] = bool(step["params"]["accept_expired"])


def _no_tls(state: State, _st: Step, _t: Topology) -> None:
    state["clients"]["validateTls"] = False


def _all_clients(_s: Step, topo: Topology) -> list[str]:
    return [p["id"] for p in pops(topo)]


CATALOGUE: dict[str, ActionSpec] = {
    "restart_service": ActionSpec("Restart service process", "routing", ("B17", "GW-1"), {"service": "string"}, "reset", _noop,
                                  "Restart a process; configuration is reloaded unchanged."),
    "rollback_config": ActionSpec("Roll back device configuration", "routing", ("B17",), {"to_revision": "string"}, "none", _rollback,
                                  "Replace B17 configuration with an archived revision."),
    "remove_rule": ActionSpec("Remove one prefix-list entry", "routing", ("B17",), {"seq": "number"}, "none", _remove_rule,
                              "Delete a single EDGE-IN prefix-list entry by sequence number."),
    "set_route": ActionSpec("Steer prefixes over backup path", "routing", ("GW-1",), {"prefixes": "string[]", "via": "string"}, "none", _set_route,
                            "Route the given customer prefixes over the low-capacity backup link.",
                            touched=lambda step, topo: [step["target"], pop_by_index(topo, 3)["id"]], lab_supported=False),
    "disable_filter": ActionSpec("Disable edge prefix filter", "routing", ("B17",), {}, "none", _disable_filter,
                                 "Remove all EDGE-IN/EDGE-OUT filtering on B17.",
                                 forbidden="Disables security filtering on B17 — restricted management paths become reachable."),
    "flush_cache": ActionSpec("Flush resolver cache", "dns", ("DNS-1",), {"names": "string[]"}, "none", _flush,
                              "Purge cached answers (empty list = all)."),
    "switch_resolver": ActionSpec("Switch clients to standby resolver", "dns", ("DNS-1",), {"to": "string"}, "none", _switch,
                                  "Point clients to the 'standby' or 'primary' resolver."),
    "restore_record": ActionSpec("Restore DNS record to previous value", "dns", ("DNS-1",), {"host": "string", "value": "string"}, "none", _restore,
                                 "Set an A record in the authoritative zone."),
    "hardcode_hosts": ActionSpec("Pin address in client hosts files", "dns", ("clients",), {"host": "string", "value": "string"}, "none", _hosts,
                                 "Write a hosts-file override on every client.",
                                 forbidden="Pins addresses on every client — bypasses DNS and creates unmanaged configuration drift.", touched=_all_clients),
    "renew_cert": ActionSpec("Renew gateway certificate", "tls", ("GW-1",), {"listeners": "string[]", "san": "string[]"}, "drain", _renew,
                             "Issue a new certificate and bind it to the given listeners ('v4', 'v6')."),
    "extend_trust_store": ActionSpec("Accept expired certificates on clients", "tls", ("clients",), {"accept_expired": "boolean"}, "none", _trust,
                                     "Make clients tolerate expired certificates.",
                                     forbidden="Makes every client accept expired certificates — weakens transport security.", touched=_all_clients,
                                     lab_supported=False),
    "disable_tls_validation": ActionSpec("Disable TLS validation on clients", "tls", ("clients",), {}, "none", _no_tls,
                                         "Turn off certificate validation on clients.",
                                         forbidden="Turns off certificate validation on every client — a security control is removed.", touched=_all_clients),
}


def _type_of(value: Any) -> str:
    if isinstance(value, list):
        return "string[]" if all(isinstance(v, str) for v in value) else "list"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    return type(value).__name__


def validate_change_set(cs: dict[str, Any], supported: set[str] | None = None) -> list[str]:
    """Schema validation for planner output: unknown actions, targets or parameters never reach a twin."""
    steps = cs.get("steps")
    if not isinstance(steps, list) or not steps:
        return ["change set has no steps"]
    errors: list[str] = []
    if len(steps) > MAX_STEPS:
        errors.append(f"change set exceeds {MAX_STEPS} steps")
    for i, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            errors.append(f"step {i}: not an object")
            continue
        action = step.get("action")
        spec = CATALOGUE.get(action) if isinstance(action, str) else None
        if spec is None:
            errors.append(f'step {i}: action "{action}" is not in the typed catalogue')
            continue
        if supported is not None and action not in supported:
            errors.append(f'step {i}: action "{action}" is not executable on this twin backend')
        if step.get("target") not in spec.targets:
            errors.append(f'step {i}: target "{step.get("target")}" not allowed for {action}')
        params = step.get("params") or {}
        if not isinstance(params, dict):
            errors.append(f"step {i}: params must be an object")
            continue
        for name, expected in spec.params.items():
            if name not in params:
                errors.append(f"step {i}: missing parameter {name}")
            elif _type_of(params[name]) != expected:
                errors.append(f"step {i}: parameter {name} must be {expected}")
        for name in params:
            if name not in spec.params:
                errors.append(f"step {i}: unexpected parameter {name}")
    return errors


def apply_change_set(state: State, cs: dict[str, Any], topo: Topology) -> State:
    nxt = clone(state)
    for step in cs["steps"]:
        CATALOGUE[step["action"]].apply(nxt, step, topo)
    return nxt


def touched_nodes(cs: dict[str, Any], topo: Topology) -> list[str]:
    nodes: list[str] = []
    for step in cs["steps"]:
        spec = CATALOGUE[step["action"]]
        for n in spec.touched(step, topo) if spec.touched else [step["target"]]:
            if n not in nodes:
                nodes.append(n)
    return nodes


def forbidden_reasons(cs: dict[str, Any]) -> list[str]:
    return [CATALOGUE[s["action"]].forbidden for s in cs["steps"] if CATALOGUE[s["action"]].forbidden]  # type: ignore[misc]


def session_impact(cs: dict[str, Any]) -> str:
    impacts = [CATALOGUE[s["action"]].session_impact for s in cs["steps"]]
    return "reset" if "reset" in impacts else "drain" if "drain" in impacts else "none"


def category_of(cs: dict[str, Any]) -> str:
    first = cs["steps"][0]
    if first["action"] == "restart_service":
        return "tls" if first["target"] == "GW-1" else "routing"
    return CATALOGUE[first["action"]].category


def required_challenges(cs: dict[str, Any]) -> list[str]:
    """Coverage is a property of the whole change, independent of the planner."""
    required: list[str] = []
    for step in cs["steps"]:
        category = category_of({"steps": [step]})
        required.extend({"routing": ["dual_stack", "secondary_failure", "surge_x3"],
                         "dns": ["warm_cache", "surge_x3"],
                         "tls": ["dual_stack", "session_continuity"]}[category])
    if session_impact(cs) != "none":
        required.append("session_continuity")
    return list(dict.fromkeys(required))


_DIFF_SCOPE = ("b17", "dns", "clients", "gw", "notes")
_NODE_OF = {"b17": "B17", "dns": "DNS-1", "clients": "clients", "gw": "GW-1", "notes": "B17"}


def _render(value: Any) -> str:
    if isinstance(value, list):
        return " | ".join(f"seq {v['seq']} {v['action']} {v['prefix']}" if isinstance(v, dict) and "seq" in v else js_str(v) for v in value)
    return js_str(value)


def _flatten(value: Any, prefix: str, out: dict[str, str]) -> None:
    if isinstance(value, dict):
        for k, v in value.items():
            _flatten(v, f"{prefix}.{k}" if prefix else k, out)
    else:
        out[prefix] = _render(value)


def diff_states(before: State, after: State) -> list[dict[str, str]]:
    lines: list[dict[str, str]] = []
    for section in _DIFF_SCOPE:
        a: dict[str, str] = {}
        b: dict[str, str] = {}
        _flatten(before[section], section, a)
        _flatten(after[section], section, b)
        for path in list(dict.fromkeys([*a, *b])):
            if a.get(path) != b.get(path):
                lines.append({"node": _NODE_OF[section], "path": path, "before": a.get(path, "—"), "after": b.get(path, "—")})
    return lines


def describe_step(step: Step) -> str:
    params = " ".join(f"{k}=[{', '.join(map(js_str, v))}]" if isinstance(v, list) else f"{k}={js_str(v)}" for k, v in step["params"].items())
    return f"{step['action']}({step['target']}{' ' + params if params else ''})"


def catalogue_for_prompt(supported: set[str] | None = None) -> list[dict[str, Any]]:
    """Catalogue as data for an LLM prompt: name, targets, typed params, policy status."""
    return [
        {"action": name, "title": spec.title, "description": spec.description, "targets": list(spec.targets), "params": spec.params,
         "policy": "forbidden" if spec.forbidden else "allowed", "category": spec.category}
        for name, spec in CATALOGUE.items()
        if supported is None or name in supported
    ]


def change_set(cs_id: str, label: str, steps: list[Step], origin: str, rationale: str, parent_id: str | None = None) -> ChangeSet:
    from .hashing import hash_of

    out: ChangeSet = {"id": cs_id, "label": label, "steps": steps, "origin": origin, "rationale": rationale,
                      "hash": hash_of({"steps": steps, "origin": origin, "parentId": parent_id})}
    if parent_id is not None:
        out["parentId"] = parent_id
    return out
