"""Public demo approvals never need a credential or bypass the evidence/apply checks."""

import pytest
from fastapi.testclient import TestClient
from test_api import read_events

from twinops.api import create_app
from twinops.cloudrun import main
from twinops.config import Settings


@pytest.fixture()
def demo(monkeypatch, tmp_path):
    monkeypatch.setenv("TWINOPS_OPERATOR_TOKEN", "server-only-test-credential")
    with TestClient(create_app(Settings(planner="runbook", twin="model", harness_enabled=True, network_url=None,
                                       require_auth=False, demo_approval=True, data_dir=tmp_path, postcheck_interval_s=0))) as client:
        yield client


def start(client, fault="route_misconfig"):
    created = client.post("/api/incidents", json={"fault": fault, "seed": 7, "pace": 0}).json()
    read_events(client, created["eventsUrl"])
    return f"/api/incidents/{created['incidentId']}"


def test_demo_approval_requires_a_decision_but_no_credential(demo):
    config = demo.get("/api/config")
    assert config.json()["demoApproval"] is True and config.json()["approvalAuth"] is False
    assert "server-only-test-credential" not in config.text
    url = start(demo)
    before = demo.get(url).json()
    assert before["status"] == "awaiting_approval" and before["approval"] is None and before["outcome"] is None
    assert before["run"]["writesDuringDiagnosis"] == 0
    result = demo.post(f"{url}/decision", json={"decision": "approve", "operator": "judge-demo"})
    assert result.status_code == 202 and result.json()["outcome"]["status"] == "applied"
    pack = demo.get(f"{url}/proof-pack").json()
    assert pack["approval"]["operator"] == "judge-demo"
    assert pack["production_writes_during_diagnosis"] == 0
    assert "server-only-test-credential" not in str(pack)
    assert demo.post(f"{url}/decision", json={"decision": "approve", "operator": "judge-demo"}).status_code == 409


def test_demo_rejection_does_not_need_a_credential(demo):
    url = start(demo)
    result = demo.post(f"{url}/decision", json={"decision": "reject", "operator": "judge-demo"})
    assert result.status_code == 202 and result.json()["outcome"]["status"] == "rejected_by_operator"


def test_demo_does_not_unlock_drift_and_still_refuses_changed_target(demo):
    url = start(demo)
    assert demo.post(f"{url}/drift").status_code == 401
    assert demo.post(f"{url}/drift", headers={"Authorization": "Bearer server-only-test-credential"}).status_code == 202
    result = demo.post(f"{url}/decision", json={"decision": "approve", "operator": "judge-demo"})
    assert result.status_code == 202 and result.json()["outcome"]["status"] == "refused"


def test_demo_cannot_approve_inconclusive_evidence(demo):
    url = start(demo, "unsupported_link_flap")
    assert demo.get(url).json()["run"]["verdict"] == "INCONCLUSIVE"
    assert demo.post(f"{url}/decision", json={"decision": "approve", "operator": "judge-demo"}).status_code == 409


def test_demo_respects_apply_kill_switch(demo, tmp_path):
    url = start(demo)
    (tmp_path / "apply-disabled").touch()
    result = demo.post(f"{url}/decision", json={"decision": "approve", "operator": "judge-demo"})
    assert result.status_code == 202 and result.json()["outcome"]["status"] == "refused"


@pytest.mark.parametrize("options", [
    {"require_auth": True}, {"harness_enabled": False},
    {"network_url": "https://external.example"},
    {"twin": "emulated", "lab_runtime": "containerlab"},
    {"twin": "emulated", "lab_runtime": "netns", "network_url": "http://127.0.0.1:8010@external.example", "network_proxy_prefix": "/metro"},
])
def test_demo_configuration_rejects_non_demo_targets_and_role_auth(options):
    settings = {"twin": "model", "harness_enabled": True, "network_url": None, "require_auth": False, "demo_approval": True}
    with pytest.raises(ValueError, match="synthetic"):
        Settings(**(settings | options))


def test_demo_configuration_accepts_only_explicit_opt_in(monkeypatch):
    monkeypatch.delenv("TWINOPS_DEMO_APPROVAL", raising=False)
    assert Settings().demo_approval is False
    monkeypatch.setenv("TWINOPS_DEMO_APPROVAL", "true")
    assert Settings(twin="emulated", lab_runtime="netns", network_url="http://127.0.0.1:8010",
                    network_proxy_prefix="/metro", harness_enabled=False, require_auth=False).demo_approval is True


def test_cloudrun_still_requires_secret_by_default(monkeypatch, capsys):
    monkeypatch.setenv("TWINOPS_PUBLIC_URL", "https://demo.example")
    monkeypatch.delenv("TWINOPS_OPERATOR_TOKEN", raising=False)
    monkeypatch.delenv("TWINOPS_DEMO_APPROVAL", raising=False)
    assert main() == 1
    assert "TWINOPS_OPERATOR_TOKEN is required" in capsys.readouterr().err


def test_cloudrun_rejects_demo_with_role_auth_before_starting_processes(monkeypatch, capsys):
    monkeypatch.setenv("TWINOPS_PUBLIC_URL", "https://demo.example")
    monkeypatch.setenv("TWINOPS_DEMO_APPROVAL", "true")
    monkeypatch.setenv("TWINOPS_REQUIRE_AUTH", "true")
    assert main() == 1
    assert "cannot be combined" in capsys.readouterr().err


def test_cloudrun_demo_children_receive_a_valid_synthetic_configuration(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setenv("TWINOPS_PUBLIC_URL", "https://demo.example")
    monkeypatch.setenv("TWINOPS_DEMO_APPROVAL", "true")
    monkeypatch.setenv("TWINOPS_REQUIRE_AUTH", "false")
    monkeypatch.delenv("TWINOPS_OPERATOR_TOKEN", raising=False)
    modules = []

    def check_child(args, *, env):
        modules.append(args[2])
        with monkeypatch.context() as child:
            for key, value in env.items():
                child.setenv(key, value)
            settings = Settings()
            assert settings.demo_approval and settings.twin == "emulated"
            assert settings.network_url == "http://127.0.0.1:8010" and settings.network_proxy_prefix == "/metro"
            assert not settings.operator_token
        return SimpleNamespace(poll=lambda: 0, returncode=0)

    def lab(args, *, env):
        check_child(args, env=env)
        return 0

    monkeypatch.setattr("twinops.cloudrun.subprocess.Popen", check_child)
    monkeypatch.setattr("twinops.cloudrun.subprocess.call", lab)
    monkeypatch.setattr("twinops.cloudrun.signal.signal", lambda *_: None)
    assert main() == 0
    assert modules == ["twinops", "twinops.lab", "twinops.network_app"]
