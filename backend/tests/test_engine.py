import asyncio

import pytest

from twinops.engine import model_session, run_model
from twinops.evaluation import evaluate_one, run_controls
from twinops.harness import SUPPORTED_FAULTS
from twinops.orchestrator import decide, run_incident
from twinops.proofpack import build_proof_pack, proof_pack_html

EXPECTED = {
    "route_misconfig": ("remove_rule", "PASS_UNDER_DEFINED_TESTS"),
    "dns_failure": ("restore_record", "PASS_UNDER_DEFINED_TESTS"),
    "cert_expiry": ("renew_cert", "PASS_WITH_WARNINGS"),
}


@pytest.mark.parametrize("fault", SUPPORTED_FAULTS)
def test_loop_verifies_bounded_fix_and_applies_only_after_approval(fault):
    async def scenario():
        session = await run_model("core", fault, 7)
        run = session.run
        action, verdict = EXPECTED[fault]
        assert run["verdict"] == verdict
        assert run["selected"]["change"]["steps"][0]["action"] == action
        assert run["selected"]["change"]["origin"] == "revision"
        assert run["writesDuringDiagnosis"] == 0
        unsafe = next(c for c in run["candidates"] if c["change"]["origin"] == "evaluation_case")
        assert unsafe["decision"] == "rejected" and unsafe["restored"]
        await decide(session, "test-operator", "evidence reviewed", "approve")
        assert session.outcome["status"] == "applied"
        assert all(p["ok"] for p in session.outcome["postChecks"])
        pack = build_proof_pack(session)
        assert pack["production_writes_during_diagnosis"] == 0
        assert pack["approval"]["operator"] == "test-operator"
        assert "<script" not in proof_pack_html(pack)

    asyncio.run(scenario())


def test_unsupported_fault_stops_inconclusive():
    session = asyncio.run(run_model("core", "unsupported_link_flap", 3))
    assert session.run["verdict"] == "INCONCLUSIVE"
    assert session.run["candidates"] == []
    assert session.status == "escalated"


def test_fault_label_never_reaches_planner_inputs():
    session = asyncio.run(run_model("core", "dns_failure", 11))
    import json

    assert not any(word in json.dumps(session.run["observation"]) for word in SUPPORTED_FAULTS)


def test_harness_targets_and_controls():
    async def scenario():
        scores = [await evaluate_one(f, s) for f in SUPPORTED_FAULTS for s in range(1, 11)]
        assert all(s["top3"] for s in scores)
        assert sum(s["unsafePassed"] for s in scores) == 0
        assert sum(s["prodWrites"] for s in scores) == 0
        controls = await run_controls()
        assert [c["id"] for c in controls if not c["ok"]] == []

    asyncio.run(scenario())


def test_paced_events_respect_minimum_spacing():
    async def scenario():
        session, topo = model_session("core", "cert_expiry", 2, pace=200)
        await run_incident(session, topo, 2)
        ats = [e["at"] for e in session.events]
        assert ats == sorted(ats) and ats[-1] >= 150

    asyncio.run(scenario())
