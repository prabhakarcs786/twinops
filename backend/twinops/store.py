"""Durable incident evidence. SQLite transactions commit before events are published."""

from __future__ import annotations

import json
import sqlite3
import statistics
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any


class IncidentStore:
    def __init__(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "incidents.sqlite3"
        with self.connect() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, created REAL NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)")
            conn.execute("CREATE TABLE IF NOT EXISTS review_trials (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL)")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        with closing(sqlite3.connect(self.path, timeout=5)) as conn, conn:
            yield conn

    def save(self, record: dict[str, Any]) -> None:
        with self.connect() as conn:
            conn.execute("INSERT INTO incidents VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload",
                         (record["id"], record["created"], record["status"], json.dumps(record, ensure_ascii=False)))

    def get(self, incident_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT payload FROM incidents WHERE id = ?", (incident_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def recent(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT payload FROM incidents ORDER BY created DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def unfinished(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT payload FROM incidents WHERE status IN ('running', 'awaiting_approval', 'applying')").fetchall()
        return [json.loads(row[0]) for row in rows]

    def needs_recovery(self) -> bool:
        with self.connect() as conn:
            rows = conn.execute("SELECT payload FROM incidents WHERE status = 'recovery_required'").fetchall()
        return any(json.loads(row[0])["backend"] == "emulated" for row in rows)

    def start_review(self, record: dict[str, Any]) -> dict[str, Any]:
        trial = {**record, "startedAt": time.time()}
        with self.connect() as conn:
            conn.execute("INSERT INTO review_trials VALUES (?, 'running', ?)", (trial["trialId"], json.dumps(trial)))
        return {key: trial[key] for key in ("trialId", "startedAt", "mode", "candidateId")}

    def finish_review(self, trial_id: str, decision: str) -> dict[str, Any]:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT payload FROM review_trials WHERE id = ?", (trial_id,)).fetchone()
            if row is None:
                raise ValueError("unknown review trial")
            trial = json.loads(row[0])
            if trial.get("decision"):
                if trial["decision"] != decision:
                    raise ValueError("this trial already has a recorded decision")
                return trial
            elapsed = time.time() - trial["startedAt"]
            if elapsed < 0 or elapsed > 3600:
                raise ValueError("review trial expired; start a new trial")
            trial.update({"decision": decision, "elapsedMs": round(elapsed * 1000), "finishedAt": time.time(),
                          "gateAgreement": decision == trial["expectedDecision"]})
            conn.execute("UPDATE review_trials SET status = 'closed', payload = ? WHERE id = ?", (json.dumps(trial), trial_id))
        return trial

    def review_results(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT payload FROM review_trials WHERE status = 'closed'").fetchall()
        return [json.loads(row[0]) for row in rows]

    def review_summary(self) -> dict[str, Any]:
        records = self.review_results()
        tasks: dict[tuple[str, str], set[str]] = {}
        for record in records:
            tasks.setdefault((record["incidentId"], record["candidateId"]), set()).add(record["mode"])
        paired = {key for key, modes in tasks.items() if modes == {"raw", "proof"}}
        results = [record for record in records if (record["incidentId"], record["candidateId"]) in paired]
        modes = []
        for mode in ("raw", "proof"):
            trials = [record for record in results if record["mode"] == mode]
            modes.append({"mode": mode, "trials": len(trials), "gateAgreements": sum(record["gateAgreement"] for record in trials),
                          "medianMs": statistics.median(record["elapsedMs"] for record in trials) if trials else None})
        return {"totalTrials": len(records), "pairedTasks": len(paired), "modes": modes,
                "note": "Exploratory anonymous trials, matched on incident and candidate. Timing is server wall time. Repeat participation and order effects are not controlled. Gate agreement is not production safety or proven time savings."}
