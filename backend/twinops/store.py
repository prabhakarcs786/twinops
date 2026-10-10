"""Durable incident evidence. SQLite transactions commit before events are published."""

from __future__ import annotations

import json
import sqlite3
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
