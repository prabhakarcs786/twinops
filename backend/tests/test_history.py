from fastapi.testclient import TestClient
from test_api import read_events

from twinops.api import create_app
from twinops.config import Settings


def test_saved_incident_survives_restart_but_approval_is_invalidated(tmp_path):
    settings = Settings(planner="runbook", data_dir=tmp_path)
    with TestClient(create_app(settings)) as client:
        created = client.post("/api/incidents", json={"pack": "enterprise", "fault": "dns_failure", "seed": 7, "pace": 0}).json()
        events = read_events(client, created["eventsUrl"])
        path = f"/api/incidents/{created['incidentId']}"
        before = client.get(path).json()
        assert client.get("/api/incidents").json()[0]["incidentId"] == created["incidentId"]
    with TestClient(create_app(settings)) as client:
        after = client.get(path).json()
        assert after["recovered"] and after["status"] == "closed"
        assert after["pack"] == "enterprise"
        assert after["outcome"]["status"] == "expired"
        assert after["run"]["selected"] == before["run"]["selected"]
        assert client.post(path + "/decision", json={"decision": "approve", "operator": "test"}).status_code == 409
        replay = read_events(client, created["eventsUrl"])
        assert replay[:len(events)] == events
        proof = client.get(path + "/proof-pack").json()
        assert proof["apply"]["status"] == "expired" and proof["selected"]


def test_completed_incident_keeps_apply_outcome_after_restart(tmp_path):
    settings = Settings(planner="runbook", data_dir=tmp_path)
    with TestClient(create_app(settings)) as client:
        created = client.post("/api/incidents", json={"fault": "route_misconfig", "seed": 7, "pace": 0}).json()
        read_events(client, created["eventsUrl"])
        path = f"/api/incidents/{created['incidentId']}"
        response = client.post(path + "/decision", json={"decision": "approve", "operator": "test"})
        assert response.status_code == 202
        before = client.get(path + "/proof-pack").json()
    with TestClient(create_app(settings)) as client:
        after = client.get(path + "/proof-pack").json()
        assert after["apply"] == before["apply"]
        summary = client.get("/api/incidents").json()[0]
        assert summary["outcome"] == "applied" and summary["cause"] and summary["fix"]
        assert summary["affected"] >= 1 and summary["journeys"] >= summary["affected"]
        assert 0 < summary["verdictMs"] <= summary["restoredMs"]
        assert after["write_log"] == before["write_log"]
        assert after["approval"] == before["approval"]


def test_memory_retests_an_applied_fix_and_requires_new_approval(tmp_path):
    settings = Settings(planner="runbook", data_dir=tmp_path)
    with TestClient(create_app(settings)) as client:
        first = client.post("/api/incidents", json={"fault": "dns_failure", "seed": 7, "pace": 0}).json()
        read_events(client, first["eventsUrl"])
        assert client.post(f"/api/incidents/{first['incidentId']}/decision", json={"decision": "approve", "operator": "test"}).status_code == 202
    with TestClient(create_app(settings)) as client:
        second = client.post("/api/incidents", json={"fault": "dns_failure", "seed": 7, "pace": 0}).json()
        events = read_events(client, second["eventsUrl"])
        detail = client.get(f"/api/incidents/{second['incidentId']}").json()
        match = detail["run"]["memory"][0]
        retested = next(candidate for candidate in detail["run"]["candidates"] if candidate["change"]["origin"] == "memory")
        assert match["sourceRunId"] == first["incidentId"]
        assert match["candidate"]["hash"] != match["sourceChangeHash"]
        assert retested["decision"] == "pass" and retested["challenges"] and retested["rollback"]["matches"]
        assert detail["approval"] is None and detail["outcome"] is None
        assert detail["status"] == "awaiting_approval"
        assert detail["run"]["writesDuringDiagnosis"] == 0
        assert any(event["kind"] == "memory_recalled" for event in events)
        assert "approval" not in match and "sealedFault" not in match
        proof = client.get(f"/api/incidents/{second['incidentId']}/proof-pack").json()
        assert proof["incident_memory"][0]["sourceRunId"] == first["incidentId"]
        assert proof["experiments"][0]["source_run_id"] == first["incidentId"]


def test_memory_never_uses_unapproved_or_different_fault_evidence(tmp_path):
    settings = Settings(planner="runbook", data_dir=tmp_path)
    with TestClient(create_app(settings)) as client:
        first = client.post("/api/incidents", json={"fault": "route_misconfig", "seed": 7, "pace": 0}).json()
        read_events(client, first["eventsUrl"])
        second = client.post("/api/incidents", json={"fault": "route_misconfig", "seed": 7, "pace": 0}).json()
        read_events(client, second["eventsUrl"])
        assert client.get(f"/api/incidents/{second['incidentId']}").json()["run"]["memory"] == []
        client.post(f"/api/incidents/{first['incidentId']}/decision", json={"decision": "approve", "operator": "test"})
        third = client.post("/api/incidents", json={"fault": "dns_failure", "seed": 7, "pace": 0}).json()
        read_events(client, third["eventsUrl"])
        assert client.get(f"/api/incidents/{third['incidentId']}").json()["run"]["memory"] == []


def test_a_similar_incident_does_not_make_a_stale_fix_pass(tmp_path):
    with TestClient(create_app(Settings(planner="runbook", data_dir=tmp_path))) as client:
        first = client.post("/api/incidents", json={"fault": "route_misconfig", "seed": 7, "pace": 0}).json()
        read_events(client, first["eventsUrl"])
        client.post(f"/api/incidents/{first['incidentId']}/decision", json={"decision": "approve", "operator": "test"})
        second = client.post("/api/incidents", json={"fault": "route_misconfig", "seed": 7, "pace": 0, "variant": "changed_config"}).json()
        read_events(client, second["eventsUrl"])
        detail = client.get(f"/api/incidents/{second['incidentId']}").json()
        assert detail["run"]["memory"][0]["sameSnapshot"] is False
        past_fix = next(candidate for candidate in detail["run"]["candidates"] if candidate["change"]["origin"] == "memory")
        assert past_fix["decision"] == "rejected"
        assert any(gate["id"] == "G2" and gate["status"] == "fail" for gate in past_fix["gates"])
        assert detail["approval"] is None and detail["run"]["writesDuringDiagnosis"] == 0


def test_review_trials_measure_matched_tasks_without_applying_changes(tmp_path, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr("twinops.store.time.time", lambda: clock[0])
    settings = Settings(planner="runbook", data_dir=tmp_path)
    with TestClient(create_app(settings)) as client:
        incident = client.post("/api/incidents", json={"fault": "dns_failure", "seed": 7, "pace": 0}).json()
        read_events(client, incident["eventsUrl"])
        path = f"/api/incidents/{incident['incidentId']}"
        before = client.get(path).json()
        candidate_id = before["run"]["selected"]["change"]["id"]
        raw = client.post(path + "/review-trials", json={"candidateId": candidate_id, "mode": "raw"}).json()
        assert "expectedDecision" not in raw
        clock[0] += 60
        result = client.post(f"/api/review-trials/{raw['trialId']}/decision", json={"decision": "accept"}).json()
        assert result["elapsedMs"] == 60_000 and result["gateAgreement"]
        assert client.get("/api/review-trials/summary").json()["pairedTasks"] == 0
        proof = client.post(path + "/review-trials", json={"candidateId": candidate_id, "mode": "proof"}).json()
        clock[0] += 35
        assert client.post(f"/api/review-trials/{proof['trialId']}/decision", json={"decision": "accept"}).status_code == 200
        summary = client.get("/api/review-trials/summary").json()
        assert summary["pairedTasks"] == 1 and [mode["medianMs"] for mode in summary["modes"]] == [60_000, 35_000]
        assert client.post(f"/api/review-trials/{proof['trialId']}/decision", json={"decision": "reject"}).status_code == 409
        after = client.get(path).json()
        assert after["approval"] == before["approval"] is None
        assert after["outcome"] is None and after["status"] == "awaiting_approval"
        assert len(client.get("/api/review-trials").json()) == 2
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/review-trials/summary").json()["totalTrials"] == 2
