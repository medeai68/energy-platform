"""Versioned SQLite schema migrations.

The platform's database (data/energy_intelligence.db) is shared by the
energy-intelligence store and the equipment store, so both components run
the same migration set instead of each creating its own tables ad hoc.

Rules:
  - Migrations are append-only: never edit an applied migration, add a new
    version instead.
  - Every migration is idempotent (IF NOT EXISTS) so it is also safe on a
    database created before this migration system existed.
  - Applied versions are recorded in schema_migrations.
"""

from __future__ import annotations

import sqlite3

MIGRATIONS: list[tuple[int, str, list[str]]] = [
    (
        1,
        "baseline: energy-intelligence snapshots",
        [
            """CREATE TABLE IF NOT EXISTS intelligence_snapshots (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 ts REAL NOT NULL,
                 day INTEGER,
                 sim_time TEXT,
                 health_score REAL,
                 payload TEXT NOT NULL
               )""",
        ],
    ),
    (
        2,
        "equipment registry, measurements and anomalies",
        [
            """CREATE TABLE IF NOT EXISTS equipment (
                 id TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 category TEXT NOT NULL,
                 building_id TEXT,
                 floor_id TEXT,
                 room_id TEXT,
                 rated_kw REAL NOT NULL DEFAULT 0,
                 source TEXT NOT NULL DEFAULT 'simulated'
                   CHECK (source IN ('live', 'imported', 'simulated')),
                 attributes TEXT NOT NULL DEFAULT '{}',
                 created_at TEXT NOT NULL DEFAULT (datetime('now')),
                 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
               )""",
            # One canonical measurement row per equipment and timestamp. The
            # composite primary key plus UPSERT on write means a repeated
            # reading updates the row instead of storing a duplicate or a
            # contradictory second version.
            """CREATE TABLE IF NOT EXISTS equipment_measurements (
                 equipment_id TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
                 measured_at INTEGER NOT NULL,
                 measured_day INTEGER NOT NULL,
                 measured_time TEXT NOT NULL,
                 actual_kw REAL,
                 expected_kw REAL,
                 energy_today_kwh REAL NOT NULL DEFAULT 0,
                 operating_hours REAL NOT NULL DEFAULT 0,
                 status TEXT NOT NULL
                   CHECK (status IN ('ok', 'warning', 'serious', 'critical')),
                 source TEXT NOT NULL
                   CHECK (source IN ('live', 'imported', 'simulated')),
                 sensors TEXT NOT NULL DEFAULT '{}',
                 PRIMARY KEY (equipment_id, measured_at)
               ) WITHOUT ROWID""",
            """CREATE INDEX IF NOT EXISTS idx_measurements_time
                 ON equipment_measurements(measured_at)""",
            """CREATE TABLE IF NOT EXISTS equipment_anomalies (
                 equipment_id TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
                 event_key TEXT NOT NULL,
                 opened_at INTEGER NOT NULL,
                 closed_at INTEGER,
                 severity TEXT NOT NULL,
                 message TEXT NOT NULL,
                 active INTEGER NOT NULL DEFAULT 1,
                 PRIMARY KEY (equipment_id, event_key)
               ) WITHOUT ROWID""",
            """CREATE INDEX IF NOT EXISTS idx_anomalies_active
                 ON equipment_anomalies(equipment_id, active)""",
        ],
    ),
    (
        3,
        "simulated-scenario configuration (rating + operating hours)",
        [
            # One scenario per simulated equipment.  The values are the
            # user-configured inputs for the constant-power scenario
            # estimate E = rated_power_kw x operating_hours (kWh/day).
            """CREATE TABLE IF NOT EXISTS equipment_scenarios (
                 equipment_id TEXT PRIMARY KEY REFERENCES equipment(id) ON DELETE CASCADE,
                 rated_kw REAL NOT NULL CHECK (rated_kw >= 0),
                 operating_hours REAL NOT NULL
                   CHECK (operating_hours >= 0 AND operating_hours <= 24),
                 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
               )""",
        ],
    ),
    (
        4,
        "scenario load factor and daily schedule start",
        [
            # Average fraction of nameplate power for the scenario estimate:
            # E = rated_kw x load_factor x operating_hours.
            """ALTER TABLE equipment_scenarios
                 ADD COLUMN load_factor REAL NOT NULL DEFAULT 1
                 CHECK (load_factor >= 0 AND load_factor <= 1)""",
            # Hour of day (0..24) at which the configured operating window
            # begins.  Default 0 preserves the Step 7 all-day behaviour.
            """ALTER TABLE equipment_scenarios
                 ADD COLUMN schedule_start REAL NOT NULL DEFAULT 0
                 CHECK (schedule_start >= 0 AND schedule_start <= 24)""",
        ],
    ),
    (
        5,
        "alarm operator workflow (acknowledge / resolve)",
        [
            # Operator handling of a persisted anomaly.  The anomaly itself
            # (active / opened_at / closed_at) stays owned by the detector;
            # these columns only record human follow-up, so an alarm can never
            # be "resolved" into hiding a condition that is still active.
            """ALTER TABLE equipment_anomalies
                 ADD COLUMN acknowledged_at TEXT""",
            """ALTER TABLE equipment_anomalies
                 ADD COLUMN acknowledged_by TEXT""",
            """ALTER TABLE equipment_anomalies
                 ADD COLUMN resolved_at TEXT""",
            """ALTER TABLE equipment_anomalies
                 ADD COLUMN resolved_by TEXT""",
            """ALTER TABLE equipment_anomalies
                 ADD COLUMN resolution_note TEXT""",
        ],
    ),
]


def current_version(conn: sqlite3.Connection) -> int:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             applied_at TEXT NOT NULL DEFAULT (datetime('now'))
           )"""
    )
    row = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
    return int(row[0] or 0)


def apply_migrations(conn: sqlite3.Connection) -> int:
    """Apply every pending migration; returns the resulting schema version."""
    current = current_version(conn)
    applied = {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}
    for version, name, statements in MIGRATIONS:
        if version in applied:
            continue
        try:
            conn.execute("BEGIN")
            for sql in statements:
                conn.execute(sql)
            conn.execute(
                "INSERT INTO schema_migrations(version, name) VALUES(?, ?)",
                (version, name),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return current_version(conn)
