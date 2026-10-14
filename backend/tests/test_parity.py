import asyncio
import json
from pathlib import Path

import pytest

from twinops.engine import run_model

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "ts_parity.json").read_text())


@pytest.mark.parametrize("case", FIXTURE, ids=lambda c: f"{c['pack']}-{c['fault']}-{c['seed']}")
def test_shared_network_model_matches_browser_observation_fixture(case):
    # The browser is a demonstration engine. Live diagnosis, graph coverage, signed approval and
    # lifecycle now have their own behavioral contracts in test_foundations.py and API tests.
    session = asyncio.run(run_model(case["pack"], case["fault"], case["seed"]))
    run = session.run
    obs = run["observation"]
    assert run["snapshotHash"] == case["snapshotHash"]
    assert [[a["id"], a["count"]] for a in obs["alarms"]] == case["alarms"]
    assert [[c["id"], c["minutesAgo"]] for c in obs["changes"]] == case["changes"]
    assert [lg["text"] for lg in obs["logs"]] == case["logs"]
    assert [[p["id"], p["ok"], p.get("failure"), p["detail"]] for p in obs["probes"]] == case["probes"]
