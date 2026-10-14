"""Behavioral checks for evidence, investigation, topology, lifecycle and pilot access."""

import asyncio
import copy
import time

import pytest
from fastapi.testclient import TestClient

from twinops.api import create_app
from twinops.approvals import sign
from twinops.config import Settings
from twinops.coverage import adequacy, select_slice
from twinops.engine import model_session, run_model
from twinops.evidence import capture_snapshot
from twinops.harness import ModelDemoNetwork
from twinops.investigation import investigate
from twinops.lab.device import LabInstance
from twinops.lab.runner import Result
from twinops.lifecycle import transition, view
from twinops.orchestrator import apply_with_approval, create_approval, decide, run_incident
from twinops.planner.runbook import RunbookPlanner
from twinops.service import Registry
from twinops.topology import build_topology


def test_evidence_has_real_collection_time_and_explicit_model_provenance():
    session = asyncio.run(run_model("core", "dns_failure", 71))
    run = session.run
    assert run["snapshot"]["consistent"]
    assert abs(run["snapshot"]["collectedAtEpoch"] - time.time()) < 10
    assert all(p["provenance"]["classification"] == "model-derived" for p in run["observation"]["probes"] + run["diagnostics"])
    assert all(p["provenance"]["classification"] == "synthetic" for p in run["observation"]["logs"])
    assert all(p["provenance"]["snapshotId"] == run["snapshot"]["id"] for p in run["diagnostics"])
    assert {p["diagnostic"] for p in run["diagnostics"]} == {"direct_ip", "dns_lookup"}
    assert run["writesDuringDiagnosis"] == 0


def test_drift_during_capture_never_becomes_approval_evidence():
    async def scenario():
        network = ModelDemoNetwork(build_topology("core"), 7)
        count = 0

        async def changing_hash():
            nonlocal count
            count += 1
            return str(count)

        network.state_hash = changing_hash
        with pytest.raises(ValueError, match="changed during evidence"):
            await capture_snapshot(network)
        assert not network.writes
    asyncio.run(scenario())


def test_unavailable_diagnostics_escalate_without_proposing_a_fix():
    async def scenario():
        session, topo = model_session("core", "dns_failure", 71)

        async def unavailable(*_):
            raise NotImplementedError

        session.demo.diagnostic = unavailable
        await run_incident(session, topo, 71)
        assert session.run["verdict"] == "INCONCLUSIVE"
        assert not session.run["candidates"]
        assert not session.run["investigation"]["sufficient"]
        assert all(not p["available"] for p in session.run["diagnostics"])
    asyncio.run(scenario())


def test_new_probe_can_change_the_leading_hypothesis():
    class InitiallyWrong(RunbookPlanner):
        async def diagnose(self, obs, topo, port, logs):
            hypotheses, diagnostics = await super().diagnose(obs, topo, port, logs)
            if not port.results():
                hypotheses = [{**hypotheses[0], "type": "tls_certificate_expired", "supporting": []}, *hypotheses[1:]]
            return hypotheses, diagnostics

    async def scenario():
        network = ModelDemoNetwork(build_topology("core"), 7)
        await network.inject_fault("dns_failure")
        obs, _, snapshot = await capture_snapshot(network)
        rounds = []

        async def emit(step):
            rounds.append(step)

        hypotheses, _, investigation = await investigate(network, InitiallyWrong(), obs, network.topo, [], snapshot, emit)
        assert rounds[0]["hypothesisBefore"] != rounds[0]["hypothesisAfter"]
        assert hypotheses[0]["type"] == "dns_record_incorrect"
        assert investigation["sufficient"]
        assert len(rounds) <= investigation["probeBudget"]
    asyncio.run(scenario())


def test_direct_ip_in_the_lab_executes_curl_without_dns_or_writes(tmp_path):
    class Runner:
        def __init__(self):
            self.calls = []

        async def exec(self, name, argv, timeout=10):
            self.calls.append(argv)
            return Result(0, "200 0.01", "")

    async def scenario():
        from twinops.model import healthy_state
        topo = build_topology("core")
        runner = Runner()
        lab = LabInstance("twin", tmp_path, topo, runner)
        state = healthy_state(topo)
        state["dns"]["primary"]["svc.demo"] = "10.40.0.99"
        before = copy.deepcopy(state)
        result = await lab.diagnostic(state, topo["journeys"][0], "direct_ip")
        assert result["ok"]
        assert len(runner.calls) == 3
        assert all(argv[0] == "curl" and "--resolve" in argv and "svc.demo:443:10.40.0.10" in argv for argv in runner.calls)
        assert state == before
    asyncio.run(scenario())


@pytest.mark.parametrize("fault", ["route_misconfig", "dns_failure", "cert_expiry", "unsupported_link_flap"])
def test_structurally_different_topology_is_verified_or_safely_escalated(fault):
    async def scenario():
        session = await run_model("branch", fault, 9001)
        run = session.run
        assert len(run["topology"]["nodes"]) == 9
        assert run["reproduction"]["coverage"]["adequate"]
        assert set(run["reproduction"]["coverage"]["affectedJourneys"]) <= set(run["reproduction"]["coverage"]["testedJourneys"])
        if fault == "unsupported_link_flap":
            assert run["verdict"] == "INCONCLUSIVE"
        else:
            assert run["selected"], [(c["change"]["id"], c["reasons"]) for c in run["candidates"]]
            await decide(session, "reviewer", "independent topology", "approve")
            assert session.outcome["status"] == "applied"
            assert all(p["ok"] for p in session.outcome["postChecks"])
    asyncio.run(scenario())


def test_graph_slice_includes_transit_and_rejects_unrepresented_dependencies():
    topo = build_topology("branch")
    obs = {"probes": [{"id": "J5", "kind": "journey", "ok": False}]}
    selected = select_slice(obs, topo)
    assert {"BRANCH", "MUC", "B17", "GW-1", "SVC-1", "DNS-1"} <= set(selected)
    topo["journeys"][-1]["dependencies"] = ["missing-firewall"]
    assert not adequacy(obs, topo, selected, "model")["adequate"]
    assert not adequacy(obs, topo, selected, "emulated")["adequate"]


@pytest.mark.parametrize("tamper", ["signature", "expiry", "content", "disabled"])
def test_execution_rechecks_approval_and_never_writes_on_refusal(tamper):
    async def scenario():
        session = await run_model("core", "dns_failure", 7)
        approval = create_approval(session, "reviewer", "reviewed", "approve")
        if tamper == "signature":
            approval["operator"] = "someone-else"
        elif tamper == "expiry":
            approval["expiresAt"] = time.time() - 1
            approval["token"] = sign(approval, session.approval_key)
        elif tamper == "content":
            session.run["selected"]["change"]["steps"][0]["params"]["value"] = "10.40.0.77"
        else:
            session.apply_enabled = False
        await apply_with_approval(session, approval)
        assert session.outcome["status"] == "refused"
        assert all(w["actor"] == "harness" for w in session.demo.writes)
    asyncio.run(scenario())


def test_delayed_postcheck_failure_rolls_back_and_retries_do_not_repeat_write():
    async def scenario():
        session = await run_model("core", "dns_failure", 7)
        before = await session.demo.state_hash()
        observe = session.demo.observe
        count = 0

        async def delayed_failure():
            nonlocal count
            count += 1
            result = await observe()
            if count == 2:
                result["probes"][0]["ok"] = False
            return result

        session.demo.observe = delayed_failure
        session.postcheck_samples = 3
        approval = create_approval(session, "reviewer", "reviewed", "approve")
        await apply_with_approval(session, approval)
        assert session.outcome["status"] == "rolled_back"
        assert await session.demo.state_hash() == before
        writes = len(session.demo.writes)
        await apply_with_approval(session, approval)
        assert len(session.demo.writes) == writes
    asyncio.run(scenario())


def test_lifecycle_and_journal_survive_restart_with_expired_authority(tmp_path):
    async def scenario():
        registry = Registry(Settings(planner="runbook", data_dir=tmp_path))
        live = await registry.create("core", "dns_failure", 7, 0, False)
        await live.task
        assert live.lifecycle()["canApprove"]
        assert registry.active() == 1
        assert registry.store.events(live.session.incident_id) == live.session.events
        with pytest.raises(ValueError, match="Invalid incident transition"):
            transition(live.session, "running")
        await registry.shutdown()
        archived = Registry(Settings(data_dir=tmp_path)).get(live.session.incident_id)
        assert archived.lifecycle()["archived"] and not archived.lifecycle()["canApprove"]
        assert view(archived.session, archived=True)["nextAction"] == "Start a fresh investigation"
    asyncio.run(scenario())


def test_role_access_and_cookie_session_protect_evidence_and_changes(tmp_path, monkeypatch):
    monkeypatch.setenv("TWINOPS_VIEWER_TOKEN", "viewer-secret-test")
    monkeypatch.setenv("TWINOPS_INVESTIGATOR_TOKEN", "investigator-secret-test")
    monkeypatch.setenv("TWINOPS_OPERATOR_TOKEN", "approver-secret-test")
    with TestClient(create_app(Settings(data_dir=tmp_path, require_auth=True))) as client:
        assert client.get("/api/incidents").status_code == 401
        preflight = client.options("/api/incidents", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-credentials"] == "true"
        assert client.post("/api/auth/session", json={"token": "invalid-\u00e9"}).status_code == 401
        response = client.post("/api/auth/session", json={"token": "viewer-secret-test"})
        assert response.status_code == 200 and "httponly" in response.headers["set-cookie"].lower()
        assert client.get("/api/incidents").status_code == 200
        assert client.post("/api/incidents", json={}).status_code == 403
        assert client.post("/api/incidents/missing/decision", json={"operator": "viewer", "decision": "approve"}).status_code == 403
        client.post("/api/auth/session", json={"token": "approver-secret-test"})
        assert client.post("/api/incidents", json={}, headers={"Origin": "https://foreign.example"}).status_code == 403


def test_study_balances_conditions_and_enforces_single_exposure_and_order(tmp_path):
    from twinops.review_study import assignments
    from twinops.store import IncidentStore

    store = IncidentStore(tmp_path)
    tasks = [{"incidentId": f"incident-{i}", "candidateId": "cand-A"} for i in range(4)]
    for task in tasks:
        store.save({"id": task["incidentId"], "created": 1, "status": "closed", "run": {"candidates": [{"change": {"id": "cand-A"}}]}})
    plan = assignments(tasks, 4, 7, "http://localhost:8000")
    for task in tasks:
        rows = [a for a in plan["assignments"] if a["incidentId"] == task["incidentId"]]
        assert [a["mode"] for a in rows].count("raw") == 2
        assert len({a["participantId"] for a in rows}) == 4
    for position in range(1, len(tasks) + 1):
        rows = [a for a in plan["assignments"] if a["order"] == position]
        assert [a["mode"] for a in rows].count("raw") == 2
    store.save_study(plan)
    first, second = plan["assignments"][:2]

    def start(row, mode=None):
        return store.start_review({"trialId": f"trial-{row['id']}", "incidentId": row["incidentId"], "candidateId": row["candidateId"],
                                   "mode": mode or row["mode"], "expectedDecision": "accept"}, row["id"])

    with pytest.raises(ValueError, match="earlier"):
        start(second)
    with pytest.raises(ValueError, match="assigned condition"):
        start(first, "proof" if first["mode"] == "raw" else "raw")
    started = start(first)
    with pytest.raises(ValueError, match="already started"):
        start(first)
    result = store.finish_review(started["trialId"], "accept")
    assert result["participantId"] == first["participantId"] and result["order"] == 1
    assert start(second)
    assert store.review_summary()["assignedTrials"] == 1


def test_missing_required_challenge_is_never_a_pass():
    async def scenario():
        session, topo = model_session("core", "cert_expiry", 7)
        session.twin.supported_challenges = {"session_continuity"}
        await run_incident(session, topo, 7)
        assert not session.run["selected"]
        assert any(g["id"] == "G4" and g["status"] == "fail" for c in session.run["candidates"] for g in c["gates"])
    asyncio.run(scenario())


def test_hot_apply_halt_is_checked_after_snapshot_preparation(tmp_path):
    async def scenario():
        session = await run_model("core", "dns_failure", 7)
        settings = Settings(data_dir=tmp_path, apply_enabled=True)
        session.apply_policy = settings.allows_apply
        capture = session.demo.capture_supported

        async def halt_while_preparing():
            state = await capture()
            (tmp_path / "apply-disabled").touch()
            return state

        session.demo.capture_supported = halt_while_preparing
        await decide(session, "reviewer", "reviewed", "approve")
        assert session.outcome["status"] == "refused"
        assert all(w["actor"] == "harness" for w in session.demo.writes)
    asyncio.run(scenario())


def test_non_harness_mode_requires_explicit_apply_enablement(monkeypatch):
    monkeypatch.delenv("TWINOPS_APPLY_ENABLED", raising=False)
    assert not Settings(harness_enabled=False).apply_enabled
    assert Settings(harness_enabled=False, apply_enabled=True).apply_enabled


def test_matrix_reports_repairs_separately_from_safe_abstention():
    from twinops.evaluation import evaluate_matrix

    report = asyncio.run(evaluate_matrix("runbook", 1, 9001))
    assert report["passed"] and len(report["runs"]) == 32
    assert len(report["controls"]) == 13
    assert sum(row["repairVerified"] for row in report["runs"]) == 20
    assert sum(row["abstained"] for row in report["runs"]) == 12
    assert {row["pack"] for row in report["runs"]} == {"core", "branch"}

