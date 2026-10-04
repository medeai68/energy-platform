"""Tiny SQLite persistence layer; optional but stdlib-only."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path


class IntelligenceStore:
    def __init__(self, path="data/energy_intelligence.db"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self.lock = threading.Lock()
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS intelligence_snapshots (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 ts REAL NOT NULL,
                 day INTEGER,
                 sim_time TEXT,
                 health_score REAL,
                 payload TEXT NOT NULL
               )"""
        )
        self.conn.commit()

    def record(self, snapshot, intelligence):
        sim = snapshot.get("sim", {})
        with self.lock:
            self.conn.execute(
                "INSERT INTO intelligence_snapshots(ts,day,sim_time,health_score,payload) VALUES(datetime('now'),?,?,?,?)",
                (sim.get("day"), sim.get("time"), intelligence.get("health_score"),
                 json.dumps(intelligence, separators=(",", ":"))),
            )
            self.conn.commit()

    def recent(self, limit=100):
        with self.lock:
            rows = self.conn.execute(
                "SELECT ts,day,sim_time,health_score,payload FROM intelligence_snapshots "
                "ORDER BY id DESC LIMIT ?", (int(limit),)
            ).fetchall()
        return [
            {"ts": r[0], "day": r[1], "time": r[2], "health_score": r[3],
             "intelligence": json.loads(r[4])}
            for r in rows
        ]

    def close(self):
        """Close the SQLite connection (required on Windows before deleting the file)."""
        with self.lock:
            self.conn.close()
