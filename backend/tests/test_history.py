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
        assert after["write_log"] == before["write_log"]
        assert after["approval"] == before["approval"]
