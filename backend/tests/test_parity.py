import asyncio
import json
from pathlib import Path

import pytest

from twinops.engine import run_model

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "ts_parity.json").read_text())
PLANNER_ONLY_KINDS = {"planner_note", "narrative", "model_call"}


@pytest.mark.parametrize("case", FIXTURE, ids=lambda c: f"{c['pack']}-{c['fault']}-{c['seed']}")
def test_python_engine_matches_typescript_engine(case):
    session = asyncio.run(run_model(case["pack"], case["fault"], case["seed"]))
    run = session.run
    obs = run["observation"]
    assert run["snapshotHash"] == case["snapshotHash"]
    assert [[a["id"], a["count"]] for a in obs["alarms"]] == case["alarms"]
    assert [[c["id"], c["minutesAgo"]] for c in obs["changes"]] == case["changes"]
    assert [lg["text"] for lg in obs["logs"]] == case["logs"]
    assert [[p["id"], p["ok"], p.get("failure"), p["detail"]] for p in obs["probes"]] == case["probes"]
    assert [[h["type"], h["score"], h["supporting"], h["contradicting"]] for h in run["hypotheses"]] == case["hypotheses"]
    assert [run["reproduction"]["matched"], run["reproduction"]["total"], run["reproduction"]["slice"]] == case["reproduction"]
    assert [[c["change"]["id"], c["decision"], "".join(g["status"] for g in c["gates"]), c["latencyDeltaMs"]] for c in run["candidates"]] == case["candidates"]
    assert run["verdict"] == case["verdict"]
    assert (run["selected"]["change"]["label"] if run["selected"] else None) == case["selected"]
    assert (run["selected"]["change"]["hash"] if run["selected"] else None) == case["selectedHash"]
    assert [e["kind"] for e in session.events if e["kind"] not in PLANNER_ONLY_KINDS] == case["kinds"]
