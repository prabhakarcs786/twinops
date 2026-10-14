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
            conn.execute("CREATE TABLE IF NOT EXISTS incident_events (incident_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (incident_id, seq))")
            conn.execute("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)")
            conn.execute("CREATE TABLE IF NOT EXISTS review_assignments (id TEXT PRIMARY KEY, study_id TEXT NOT NULL, participant_id TEXT NOT NULL, position INTEGER NOT NULL, trial_id TEXT UNIQUE, payload TEXT NOT NULL)")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        with closing(sqlite3.connect(self.path, timeout=5)) as conn, conn:
            yield conn

    def save(self, record: dict[str, Any]) -> None:
        with self.connect() as conn:
            for event in record.get("events", []):
                conn.execute("INSERT OR IGNORE INTO incident_events VALUES (?, ?, ?)",
                             (record["id"], event["seq"], json.dumps(event, ensure_ascii=False)))
            approval = record.get("approval") or {}
            if approval.get("operationId"):
                conn.execute("INSERT INTO operations VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload",
                             (approval["operationId"], record["id"], record["status"], json.dumps({"approval": approval, "outcome": record.get("outcome")})))
            conn.execute("INSERT INTO incidents VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload",
                         (record["id"], record["created"], record["status"], json.dumps(record, ensure_ascii=False)))

    def events(self, incident_id: str, after: int = 0) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT payload FROM incident_events WHERE incident_id = ? AND seq > ? ORDER BY seq", (incident_id, after)).fetchall()
        return [json.loads(row[0]) for row in rows]

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

    def save_study(self, plan: dict[str, Any]) -> None:
        with self.connect() as conn:
            for assignment in plan["assignments"]:
                row = conn.execute("SELECT payload FROM incidents WHERE id = ?", (assignment["incidentId"],)).fetchone()
                run = json.loads(row[0]).get("run", {}) if row else {}
                if not any(c["change"]["id"] == assignment["candidateId"] for c in run.get("candidates", [])):
                    raise ValueError("Every study task must reference an existing tested candidate")
                conn.execute("INSERT INTO review_assignments VALUES (?, ?, ?, ?, NULL, ?)",
                             (assignment["id"], assignment["studyId"], assignment["participantId"], assignment["order"], json.dumps(assignment)))

    def start_review(self, record: dict[str, Any], assignment_id: str | None = None) -> dict[str, Any]:
        trial = {**record, "startedAt": time.time()}
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if assignment_id:
                row = conn.execute("SELECT trial_id, payload FROM review_assignments WHERE id = ?", (assignment_id,)).fetchone()
                if not row:
                    raise ValueError("Unknown study assignment")
                assignment = json.loads(row[1])
                if any(assignment[key] != trial[key] for key in ("incidentId", "candidateId", "mode")):
                    raise ValueError("Review task does not match the assigned condition")
                if row[0]:
                    raise ValueError("This assignment has already started; repeat exposure cannot be measured as a new trial")
                pending = conn.execute("SELECT 1 FROM review_assignments a LEFT JOIN review_trials t ON t.id = a.trial_id "
                                       "WHERE a.study_id = ? AND a.participant_id = ? AND a.position < ? AND (t.status IS NULL OR t.status != 'closed')",
                                       (assignment["studyId"], assignment["participantId"], assignment["order"])).fetchone()
                if pending:
                    raise ValueError("Complete the earlier assigned review first")
                trial.update({key: assignment[key] for key in ("studyId", "participantId", "order")})
                trial["assignmentId"] = assignment_id
                conn.execute("UPDATE review_assignments SET trial_id = ? WHERE id = ?", (trial["trialId"], assignment_id))
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
                "assignedTrials": sum(bool(r.get("assignmentId")) for r in records),
                "studies": sorted({r["studyId"] for r in records if r.get("studyId")}),
                "note": "Exploratory trials matched on incident and candidate. Export assignment, pseudonymous participant and order fields for study analysis; open trials lack those controls. "
                        "Timing is server wall time. Gate agreement is not production safety or proven time savings."}
