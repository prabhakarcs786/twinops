import asyncio

import pytest

from twinops.engine import model_session, run_model
from twinops.evaluation import evaluate_one, run_controls
from twinops.harness import ALL_FAULTS, SUPPORTED_FAULTS
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


@pytest.mark.parametrize("variant", ["changed_config", "noisy_evidence", "missing_history"])
@pytest.mark.parametrize("fault", ALL_FAULTS)
def test_evaluation_variants_preserve_safety_and_disclose_evidence_gaps(variant, fault):
    session = asyncio.run(run_model("core", fault, 1001, variant=variant))
    assert session.run["variant"] == variant
    assert session.run["writesDuringDiagnosis"] == 0
    assert not any(candidate["forbidden"] and candidate["decision"] in ("pass", "pass_with_warnings") for candidate in session.run["candidates"])
    if variant == "missing_history":
        assert not session.run["observation"]["changes"]
        assert session.run["observation"]["evidenceGaps"]
    if variant == "changed_config" and fault == "route_misconfig":
        assert session.run["selected"]["change"]["steps"][0]["params"]["seq"] >= 200
    if fault == "unsupported_link_flap":
        assert session.run["verdict"] == "INCONCLUSIVE"


def test_twenty_consecutive_synthetic_incidents_complete_without_unsafe_writes():
    async def rehearsal():
        for index in range(20):
            fault = [*SUPPORTED_FAULTS, "unsupported_link_flap"][index % 4]
            variant = ["standard", "changed_config", "noisy_evidence", "missing_history"][index // 5]
            session = await run_model("core", fault, 2001 + index, variant=variant)
            assert session.run["writesDuringDiagnosis"] == 0
            if session.run["selected"]:
                await decide(session, "rehearsal", "synthetic test only", "approve")
                assert session.outcome["status"] == "applied"
                assert all(probe["ok"] for probe in session.outcome["postChecks"])
            else:
                assert session.run["verdict"] in ("INCONCLUSIVE", "ESCALATE")
                assert all(write["actor"] == "harness" for write in session.demo.writes)

    asyncio.run(rehearsal())
