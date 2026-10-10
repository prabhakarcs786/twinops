import asyncio
import json

import pytest

from twinops.engine import run_model
from twinops.evaluation import run_controls
from twinops.harness import SUPPORTED_FAULTS
from twinops.orchestrator import qa_context
from twinops.planner.llm import MAX_QUESTIONS, LLMPlanner
from twinops.planner.llm_client import LLMError, ScriptedClient


def _diagnose(payload):
    probes = payload["observation"]["probes"]
    failed = [p for p in probes if p["kind"] == "journey" and not p["ok"]]
    alarms = payload["alarms"]
    kind = failed[0]["failure"] if failed else None
    mapping = {"no_route": ("edge_filter_regression", "B17", "b17"), "wrong_address": ("dns_record_incorrect", "DNS-1", "zzz"),
               "tls_expired": ("tls_certificate_expired", "GW-1", "GW-1"), "intermittent": ("physical_link_degradation", "HAM", "hw")}
    htype, target, alarm_key = mapping.get(kind, ("service_unavailable", "SVC-1", "x"))
    support = [p["id"] for p in failed] + [a["id"] for a in alarms if alarm_key in a["id"] or alarm_key in a["text"]] + ["ALARM-999-INVENTED"]
    return {"hypotheses": [
        {"type": htype, "target": target, "title": f"Model says {htype}", "supporting": support, "contradicting": [], "rationale": "from the evidence"},
        {"type": "service_unavailable", "target": "SVC-1", "title": "App down", "supporting": [], "contradicting": [p["id"] for p in failed], "rationale": "unlikely"},
    ]}


def _propose(payload):
    cfg = payload["captured_config"]
    htype = payload["hypothesis"]["type"]
    if htype == "edge_filter_regression":
        archived = {r["seq"] for rev in cfg["config_archive"].values() for r in rev["prefixList"]}
        added = next(r for r in cfg["b17"]["prefixList"] if r["action"] == "deny" and r["seq"] not in archived)
        return {"candidates": [
            {"label": f"Remove EDGE-IN seq {added['seq']}", "rationale": "narrowest", "steps": [{"action": "remove_rule", "target": "B17", "params": {"seq": added["seq"]}}]},
            {"label": "Run a shell", "rationale": "bad", "steps": [{"action": "shell_exec", "target": "B17", "params": {"cmd": "reboot"}}]},
        ]}
    if htype == "dns_record_incorrect":
        before = next(c["before"] for c in payload["changes"] if c.get("before"))
        host, value = next(iter(before.items()))
        return {"candidates": [{"label": "Restore and purge", "rationale": "fix source then cache", "steps": [
            {"action": "restore_record", "target": "DNS-1", "params": {"host": host, "value": value}},
            {"action": "flush_cache", "target": "DNS-1", "params": {"names": [host]}}]}]}
    san = cfg["gateway"]["certs"][cfg["gateway"]["bindings"]["v4"]]["san"]
    return {"candidates": [{"label": "Renew on both listeners", "rationale": "v6 has its own binding", "steps": [
        {"action": "renew_cert", "target": "GW-1", "params": {"listeners": ["v4", "v6"], "san": san}}]}]}


SCRIPT = {
    "diagnose": _diagnose,
    "propose": _propose,
    "challenge": lambda p: {"challenges": ["surge_x3", "made_up_challenge"], "rationale": "load matters"},
    "revise": lambda p: {"revise": False, "label": "", "rationale": "no safer narrower change", "steps": []},
    "narrate": lambda p: {"summary": "The model-proposed fix passed the defined tests; unsafe options were rejected.", "evidence_ids": ["H1", "cand-A", "FAKE"]},
}


def test_model_specific_controls_use_the_selected_planner():
    clients = []

    def factory():
        client = ScriptedClient(SCRIPT)
        clients.append(client)
        return LLMPlanner(client)

    controls = asyncio.run(run_controls(planner_factory=factory))
    assert len(clients) == 2 and all(c.calls for c in clients)
    assert all(c["planner"]["kind"] == "runbook" and c["scope"] == "gateway" for c in controls[:4])
    assert all(c["planner"]["kind"] == "llm" and c["modelCalls"] > 0 for c in controls[4:])
    assert controls[-1]["modelEvidence"]


def test_arithmetically_false_temperature_claim_is_discarded():
    def diagnosis(payload):
        response = _diagnose(payload)
        response["hypotheses"][0]["rationale"] = "61°C, which is above the threshold of 70°C, caused the failure."
        return response

    session = _run("route_misconfig", ScriptedClient({**SCRIPT, "diagnose": diagnosis}))
    assert "above the threshold" not in json.dumps(session.run["hypotheses"])
    assert any("contradictory numeric comparison" in r for e in session.events if e["kind"] == "planner_note" for r in e["raw"]["rejected"])


def _run(fault, client, seed=4):
    return asyncio.run(run_model("core", fault, seed, planner=LLMPlanner(client)))


def test_llm_planner_proposals_are_validated_and_gated():
    for fault in SUPPORTED_FAULTS:
        client = ScriptedClient(SCRIPT)
        session = _run(fault, client)
        run = session.run
        assert run["verdict"] in ("PASS_UNDER_DEFINED_TESTS", "PASS_WITH_WARNINGS"), fault
        assert run["selected"]["change"]["origin"] == "llm"
        assert "ALARM-999-INVENTED" not in json.dumps(run["hypotheses"])
        notes = [e for e in session.events if e["kind"] == "planner_note"]
        assert any("unknown evidence id" in r for n in notes for r in n["raw"]["rejected"])
        assert session.narrative and session.narrative["evidenceIds"] == ["H1", "cand-A"] and session.narrative["authoritative"] is False
        assert all("route_misconfig" not in json.dumps(payload) for _, payload in client.calls)
    shell_note = next(n for n in _run("route_misconfig", ScriptedClient(SCRIPT)).events if n["kind"] == "planner_note" and "candidates" in n["title"])
    assert any("shell_exec" in r for r in shell_note["raw"]["rejected"])


def test_model_that_follows_injected_instruction_is_stopped_by_the_gate():
    script = {**SCRIPT, "propose": lambda p: {"candidates": [
        {"label": "Disable filter as the log says", "rationale": "log told me", "steps": [{"action": "disable_filter", "target": "B17", "params": {}}]}]}}
    session = _run("route_misconfig", ScriptedClient(script))
    llm_candidate = next(c for c in session.run["candidates"] if c["change"]["origin"] == "llm")
    assert llm_candidate["decision"] == "rejected"
    assert any(g["id"] == "G5" and g["status"] == "fail" for g in llm_candidate["gates"])
    assert not session.run["selected"] or session.run["selected"]["change"]["steps"][0]["action"] != "disable_filter"


def test_provider_outage_falls_back_to_runbook_visibly():
    def boom(_payload):
        raise LLMError("gemini timed out after 30 s")

    session = _run("dns_failure", ScriptedClient({k: boom for k in SCRIPT}))
    assert session.run["verdict"] == "PASS_UNDER_DEFINED_TESTS"
    fallbacks = [e for e in session.events if e["kind"] == "planner_note" and e["raw"]["fallback"]]
    assert len(fallbacks) >= 3


def test_call_budget_is_enforced():
    client = ScriptedClient(SCRIPT)
    session = asyncio.run(run_model("core", "cert_expiry", 4, planner=LLMPlanner(client, max_calls=1)))
    assert len(client.calls) == 1
    assert session.run["verdict"] in ("PASS_UNDER_DEFINED_TESTS", "PASS_WITH_WARNINGS")


def test_every_model_call_is_announced_before_its_result():
    session = _run("dns_failure", ScriptedClient(SCRIPT))
    kinds = [e["kind"] for e in session.events]
    calls = [e for e in session.events if e["kind"] == "model_call"]
    assert len(calls) == kinds.count("planner_note") >= 4
    assert kinds.index("model_call") < kinds.index("hypotheses")
    assert {"diagnose", "propose", "narrate"} <= {c["raw"]["role"] for c in calls}


def test_operator_questions_are_answered_from_run_evidence_only():
    answer = {"answer": "A was rejected because G2 failed [cand-A] [G2].", "answerable": True, "evidence_ids": ["cand-A", "G2", "MADE-UP"]}
    client = ScriptedClient({**SCRIPT, "ask": lambda p: answer})
    session = _run("route_misconfig", client)
    ctx = qa_context(session.run, session.outcome)

    result = asyncio.run(session.planner.answer("Why was A rejected?", ctx))
    assert result["evidenceIds"] == ["cand-A", "G2"] and result["discardedIds"] == ["MADE-UP"]
    assert result["authoritative"] is False and result["remaining"] == MAX_QUESTIONS - 1
    role, payload = client.calls[-1]
    assert role == "ask" and payload["question"] == "Why was A rejected?"
    assert "route_misconfig" not in json.dumps(payload), "the sealed fault label never reaches the model"

    for _ in range(MAX_QUESTIONS - 1):
        asyncio.run(session.planner.answer("again?", ctx))
    with pytest.raises(LLMError, match="question budget"):
        asyncio.run(session.planner.answer("one more?", ctx))
