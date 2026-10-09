import json

import pytest
from fastapi.testclient import TestClient

from twinops.api import create_app
from twinops.config import Settings


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("TWINOPS_PLANNER", "runbook")
    monkeypatch.setenv("TWINOPS_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("TWINOPS_OPERATOR_TOKEN", raising=False)
    with TestClient(create_app(Settings())) as c:
        yield c


def read_events(client, url):
    """TestClient buffers whole responses, so wait for the run to settle, then read the backlog without following."""
    import time

    incident = url.split("/")[3]
    for _ in range(200):
        if client.get(f"/api/incidents/{incident}").json()["status"] != "running":
            break
        time.sleep(0.02)
    resp = client.get(url, params={"follow": "false"})
    assert resp.headers["content-type"].startswith("text/event-stream")
    events, current = [], None
    for line in resp.text.splitlines():
        if line.startswith("event: "):
            current = line[7:]
        elif line.startswith("data: ") and current == "run":
            events.append(json.loads(line[6:]))
    return events


def test_config_and_security_headers(client):
    resp = client.get("/api/config")
    body = resp.json()
    assert body["planner"]["kind"] == "runbook"
    assert body["twin"]["backend"] == "model"
    assert "default-src 'self'" in resp.headers["content-security-policy"]
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_incident_streams_events_then_applies_after_approval(client):
    created = client.post("/api/incidents", json={"pack": "core", "fault": "route_misconfig", "seed": 7, "pace": 0}).json()
    events = read_events(client, created["eventsUrl"])
    assert events[0]["kind"] == "fault_injected" and events[-1]["kind"] == "awaiting_approval"
    assert all(e["frame"]["counters"]["productionWritesDuringDiagnosis"] == 0 for e in events)
    assert client.get(f"/api/incidents/{created['incidentId']}/reveal").json()["code"] == "F1"

    run = client.get(f"/api/incidents/{created['incidentId']}").json()
    assert run["status"] == "awaiting_approval" and run["run"]["verdict"] == "PASS_UNDER_DEFINED_TESTS"

    resp = client.post(f"/api/incidents/{created['incidentId']}/decision", json={"decision": "approve", "operator": "noc-07", "comment": "ok"})
    assert resp.status_code == 202 and resp.json()["outcome"]["status"] == "applied"
    pack = client.get(f"/api/incidents/{created['incidentId']}/proof-pack").json()
    assert pack["approval"]["operator"] == "noc-07" and pack["production_writes_during_diagnosis"] == 0
    html = client.get(f"/api/incidents/{created['incidentId']}/proof-pack?format=html")
    assert "sandbox" in html.headers["content-security-policy"]


def test_ask_requires_an_llm_planner(client):
    created = client.post("/api/incidents", json={"pack": "core", "fault": "dns_failure", "seed": 3, "pace": 0}).json()
    read_events(client, created["eventsUrl"])
    resp = client.post(f"/api/incidents/{created['incidentId']}/ask", json={"question": "Why was A rejected?"})
    assert resp.status_code == 409 and "LLM planner" in resp.json()["detail"]
    assert client.post(f"/api/incidents/{created['incidentId']}/ask", json={"question": "x" * 401}).status_code == 422


def test_validation_rejects_bad_input(client):
    assert client.post("/api/incidents", json={"fault": "drop_tables"}).status_code == 422
    created = client.post("/api/incidents", json={"fault": "dns_failure", "seed": 2, "pace": 0}).json()
    read_events(client, created["eventsUrl"])
    bad = client.post(f"/api/incidents/{created['incidentId']}/decision", json={"decision": "approve", "operator": "<script>"})
    assert bad.status_code == 422
    assert client.get("/api/incidents/nope").status_code == 404


def test_reveal_is_sealed_while_running_and_drift_refuses_apply(client):
    created = client.post("/api/incidents", json={"fault": "cert_expiry", "seed": 3, "pace": 0}).json()
    read_events(client, created["eventsUrl"])
    assert client.post(f"/api/incidents/{created['incidentId']}/drift").status_code == 202
    out = client.post(f"/api/incidents/{created['incidentId']}/decision", json={"decision": "approve", "operator": "noc-07"}).json()
    assert out["outcome"]["status"] == "refused"
    assert client.post(f"/api/incidents/{created['incidentId']}/decision", json={"decision": "approve", "operator": "noc-07"}).status_code == 409


def test_operator_token_guards_decisions(monkeypatch, tmp_path):
    monkeypatch.setenv("TWINOPS_PLANNER", "runbook")
    monkeypatch.setenv("TWINOPS_OPERATOR_TOKEN", "s3cret-pass")
    with TestClient(create_app(Settings())) as c:
        created = c.post("/api/incidents", json={"fault": "dns_failure", "seed": 5, "pace": 0}).json()
        read_events(c, created["eventsUrl"])
        url = f"/api/incidents/{created['incidentId']}/decision"
        assert c.post(url, json={"decision": "approve", "operator": "noc-07"}).status_code == 401
        assert c.post(url, json={"decision": "approve", "operator": "noc-07"}, headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert c.post(url, json={"decision": "approve", "operator": "noc-07"}, headers={"Authorization": "Bearer s3cret-pass"}).status_code == 202


def test_rate_limit(monkeypatch, tmp_path):
    monkeypatch.setenv("TWINOPS_PLANNER", "runbook")
    monkeypatch.setenv("TWINOPS_RATE_LIMIT_PER_MIN", "2")
    monkeypatch.setenv("TWINOPS_MAX_ACTIVE_RUNS", "10")
    with TestClient(create_app(Settings())) as c:
        codes = [c.post("/api/incidents", json={"fault": "dns_failure", "pace": 0}).status_code for _ in range(3)]
        assert codes == [202, 202, 429]


def test_spa_static_serving_blocks_traversal(monkeypatch, tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>spa</title>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path.parent / "secret.txt").write_text("nope")
    monkeypatch.setenv("TWINOPS_PLANNER", "runbook")
    monkeypatch.setenv("TWINOPS_STATIC_DIR", str(tmp_path))
    with TestClient(create_app(Settings())) as c:
        assert "spa" in c.get("/workbench").text
        assert c.get("/assets/app.js").headers["cache-control"].endswith("immutable")
        assert "nope" not in c.get("/../secret.txt").text
        assert "nope" not in c.get("/%2e%2e/secret.txt").text
