import json
import socket
import threading
import time

import httpx
import pytest
import uvicorn

from twinops.api import create_app
from twinops.config import Settings


@pytest.fixture()
def server(monkeypatch, tmp_path):
    monkeypatch.setenv("TWINOPS_PLANNER", "runbook")
    monkeypatch.setenv("TWINOPS_DATA_DIR", str(tmp_path))
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(Settings()), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    thread.join(5)


def test_sse_streams_live_and_resumes_after_decision(server):
    with httpx.Client(base_url=server, timeout=20) as client:
        created = client.post("/api/incidents", json={"fault": "route_misconfig", "seed": 9, "pace": 4}).json()
        kinds, timestamps = [], []
        with client.stream("GET", created["eventsUrl"]) as resp:
            event = None
            for line in resp.iter_lines():
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: ") and event == "run":
                    data = json.loads(line[6:])
                    kinds.append(data["kind"])
                    timestamps.append(time.monotonic())
                    if data["kind"] == "awaiting_approval":
                        break
        assert kinds[0] == "fault_injected" and kinds[-1] == "awaiting_approval"
        assert timestamps[-1] - timestamps[0] > 1.0, "events should arrive progressively when paced"

        last = len(kinds)
        client.post(f"/api/incidents/{created['incidentId']}/decision", json={"decision": "approve", "operator": "noc-07"})
        tail = []
        with client.stream("GET", created["eventsUrl"], headers={"Last-Event-ID": str(last)}) as resp:
            event = None
            for line in resp.iter_lines():
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: ") and event == "run":
                    tail.append(json.loads(line[6:])["kind"])
                elif line.startswith("data: ") and event == "end":
                    break
        assert tail == ["approval_recorded", "applied", "post_check"]
