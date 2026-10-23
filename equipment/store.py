"""SQLite store for the equipment data model.

Responsibilities
  - keep the equipment registry in sync with the simulation's hierarchy
    (stable ids, names, categories, parent ids, ratings, data source,
    equipment-specific attributes),
  - persist measurement samples with UPSERT semantics: one canonical row
    per (equipment_id, measured_at) - repeated writes update in place, so
    duplicate or contradictory versions of the same measurement cannot
    accumulate,
  - keep anomaly records in sync (open anomalies are updated in place and
    closed when they recover; engine resets start a new anomaly epoch),
  - persist per-equipment scenario configuration (rated power, daily
    operating hours, load factor and schedule start) for simulated what-if
    estimates.  The store keeps the inputs; the documented calculations live
    in ``calculations.py``.

Cadence is controlled by the caller (server.py): samples are written every
few real seconds, which is independent of the simulation speed. The
measurement timestamp is the simulation's absolute minute, not wall time.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

from .calculations import scenario_energy, validate_scenario_config
from .migrations import apply_migrations
from .model import CATEGORY_LABELS


def _json(obj) -> str:
    return json.dumps(obj or {}, sort_keys=True, separators=(",", ":"))


class EquipmentStore:
    def __init__(self, path="data/energy_intelligence.db"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA busy_timeout = 5000")
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.lock = threading.Lock()
        self._epoch = 0          # incremented when the simulation is reset
        self._last_abs = None    # last measurement time seen
        # wall-clock time of the last persisted sample per equipment, used by
        # the data-availability visualization (ages are real seconds, not sim)
        self._last_sample_wall = {}
        self._sample_source = {}
        self.schema_version = apply_migrations(self.conn)
        self.conn.commit()

    # ---------------- registry ----------------

    @staticmethod
    def _all_devices(snapshot):
        return (list(snapshot.get("devices", []))
                + list(snapshot.get("panels", []))
                + list(snapshot.get("equipment", [])))

    def sync_registry(self, snapshot):
        """Upsert every device's stable identity into the equipment table."""
        rows = []
        for d in self._all_devices(snapshot):
            parent = d.get("parent") or {}
            rows.append((
                d["id"], d["name"], d.get("kind", "generic"),
                parent.get("building"), parent.get("floor"), parent.get("room"),
                float(d.get("rating") or 0.0),
                d.get("source", "simulated"),
                _json(d.get("attributes")),
            ))
        with self.lock:
            self.conn.executemany(
                """INSERT INTO equipment
                     (id, name, category, building_id, floor_id, room_id,
                      rated_kw, source, attributes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     category = excluded.category,
                     building_id = excluded.building_id,
                     floor_id = excluded.floor_id,
                     room_id = excluded.room_id,
                     rated_kw = excluded.rated_kw,
                     source = excluded.source,
                     attributes = excluded.attributes,
                     updated_at = datetime('now')""",
                rows,
            )
            self.conn.commit()
        return len(rows)

    # ---------------- measurements ----------------

    @staticmethod
    def _abs_minutes(sim):
        return (int(sim.get("day") or 1) - 1) * 1440 + int(sim.get("minutes") or 0)

    def record_sample(self, snapshot):
        """Persist one canonical measurement row per device.

        Same equipment + same sim timestamp => the row is updated, never
        duplicated. Returns the number of devices sampled.
        """
        sim = snapshot.get("sim") or {}
        measured_at = self._abs_minutes(sim)
        day = int(sim.get("day") or 1)
        sim_time = sim.get("time") or ""
        devices = self._all_devices(snapshot)

        with self.lock:
            self._begin_sample(measured_at)
            rows = []
            for d in devices:
                rows.append((
                    d["id"], measured_at, day, sim_time,
                    d.get("actual"), d.get("expected"),
                    float(d.get("energy_today_kwh") or 0.0),
                    float(d.get("operating_hours") or 0.0),
                    d.get("status", "ok"),
                    d.get("source", "simulated"),
                    _json(d.get("extra")),
                ))
            self.conn.executemany(
                """INSERT INTO equipment_measurements
                     (equipment_id, measured_at, measured_day, measured_time,
                      actual_kw, expected_kw, energy_today_kwh, operating_hours,
                      status, source, sensors)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(equipment_id, measured_at) DO UPDATE SET
                     actual_kw = excluded.actual_kw,
                     expected_kw = excluded.expected_kw,
                     energy_today_kwh = excluded.energy_today_kwh,
                     operating_hours = excluded.operating_hours,
                     status = excluded.status,
                     source = excluded.source,
                     sensors = excluded.sensors""",
                rows,
            )
            self.conn.commit()
            self._sync_anomalies(snapshot, measured_at)
            now = time.time()
            for d in devices:
                self._last_sample_wall[d["id"]] = now
                self._sample_source[d["id"]] = d.get("source", "simulated")
        return len(devices)

    def import_measurement(self, equipment_id, measured_at, measured_day,
                           measured_time, actual_kw=None, expected_kw=None,
                           energy_today_kwh=0.0, operating_hours=0.0,
                           status="ok", source="imported", sensors=None):
        """Ingest a measurement from a live feed or an imported dataset.

        Goes through the same canonical UPSERT as simulated samples, so an
        imported reading for an (equipment, timestamp) pair that already
        exists is corrected in place rather than duplicated. This is the
        entry point for `source='live'` (IoT/Modbus collector) and
        `source='imported'` (CSV/dataset bridge) data.
        """
        from .model import SOURCES, STATUSES
        if source not in SOURCES:
            raise ValueError(f"invalid data source {source!r}")
        if status not in STATUSES:
            raise ValueError(f"invalid status {status!r}")
        with self.lock:
            exists = self.conn.execute(
                "SELECT 1 FROM equipment WHERE id = ?", (equipment_id,)).fetchone()
            if not exists:
                raise ValueError(f"unknown equipment {equipment_id!r}")
            self.conn.execute(
                """INSERT INTO equipment_measurements
                     (equipment_id, measured_at, measured_day, measured_time,
                      actual_kw, expected_kw, energy_today_kwh, operating_hours,
                      status, source, sensors)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(equipment_id, measured_at) DO UPDATE SET
                     actual_kw = excluded.actual_kw,
                     expected_kw = excluded.expected_kw,
                     energy_today_kwh = excluded.energy_today_kwh,
                     operating_hours = excluded.operating_hours,
                     status = excluded.status,
                     source = excluded.source,
                     sensors = excluded.sensors""",
                (equipment_id, int(measured_at), int(measured_day), measured_time,
                 actual_kw, expected_kw, float(energy_today_kwh),
                 float(operating_hours), status, source, _json(sensors)),
            )
            self.conn.commit()
            self._last_sample_wall[equipment_id] = time.time()
            self._sample_source[equipment_id] = source

    # ---------------- scenario configuration ----------------

    @staticmethod
    def _scenario_view(row):
        """Scenario configuration + its calculated estimate.

        ``row`` is (equipment_id, rated_kw, operating_hours, load_factor,
        schedule_start, updated_at, source).  The calculation itself is the
        documented scenario formula
        E = rated_kw x load_factor x operating_hours.
        """
        view = {
            "equipment_id": row[0],
            "updated_at": row[5],
            "source": row[6],
        }
        view.update(scenario_energy(row[1], row[2], row[3], row[4]))
        return view

    def get_scenario(self, equipment_id):
        """Configured scenario for one equipment, or None."""
        with self.lock:
            row = self.conn.execute(
                """SELECT s.equipment_id, s.rated_kw, s.operating_hours,
                          s.load_factor, s.schedule_start, s.updated_at,
                          e.source
                     FROM equipment_scenarios s
                     JOIN equipment e ON e.id = s.equipment_id
                    WHERE s.equipment_id = ?""",
                (equipment_id,),
            ).fetchone()
        return self._scenario_view(row) if row else None

    def set_scenario(self, equipment_id, rated_kw, operating_hours,
                     load_factor=1.0, schedule_start=0.0):
        """Save the scenario inputs for a simulated equipment.

        Rejects unknown equipment and non-simulated sources: scenario
        configuration describes a simulated what-if and must not be presented
        as live/imported data.  Returns the stored scenario + calculation.
        """
        config = validate_scenario_config(
            rated_kw, operating_hours, load_factor, schedule_start)
        rated = config["rated_kw"]
        hours = config["operating_hours"]
        load = config["load_factor"]
        start = config["schedule_start"]
        with self.lock:
            row = self.conn.execute(
                "SELECT source FROM equipment WHERE id = ?", (equipment_id,)
            ).fetchone()
            if row is None:
                raise ValueError(f"unknown equipment {equipment_id!r}")
            if row[0] != "simulated":
                raise ValueError(
                    "scenario configuration is only available for simulated equipment")
            self.conn.execute(
                """INSERT INTO equipment_scenarios
                     (equipment_id, rated_kw, operating_hours, load_factor,
                      schedule_start)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(equipment_id) DO UPDATE SET
                     rated_kw = excluded.rated_kw,
                     operating_hours = excluded.operating_hours,
                     load_factor = excluded.load_factor,
                     schedule_start = excluded.schedule_start,
                     updated_at = datetime('now')""",
                (equipment_id, rated, hours, load, start),
            )
            self.conn.commit()
            view_row = self.conn.execute(
                """SELECT s.equipment_id, s.rated_kw, s.operating_hours,
                          s.load_factor, s.schedule_start, s.updated_at,
                          e.source
                     FROM equipment_scenarios s
                     JOIN equipment e ON e.id = s.equipment_id
                    WHERE s.equipment_id = ?""",
                (equipment_id,),
            ).fetchone()
        return self._scenario_view(view_row)

    def clear_scenario(self, equipment_id):
        """Remove a scenario configuration; returns True when one existed."""
        with self.lock:
            cur = self.conn.execute(
                "DELETE FROM equipment_scenarios WHERE equipment_id = ?",
                (equipment_id,),
            )
            self.conn.commit()
            return cur.rowcount > 0

    # ---------------- availability ----------------

    def availability(self):
        """Per-equipment data availability for the visualization layer.

        Ages are real (wall-clock) seconds since the last persisted sample.
        Equipment never sampled is absent, which the UI renders as missing -
        it must not invent readings for it.
        """
        now = time.time()
        with self.lock:
            return {
                dev_id: {
                    "age_seconds": round(max(0.0, now - ts), 1),
                    "source": self._sample_source.get(dev_id, "simulated"),
                }
                for dev_id, ts in self._last_sample_wall.items()
            }

    # ---------------- anomalies ----------------

    def _begin_sample(self, measured_at):
        """Detect a simulation reset (time moved backwards) and start a new
        anomaly epoch so new event ids cannot collide with old records."""
        if self._last_abs is not None and measured_at < self._last_abs:
            self._epoch += 1
            self._close_active_anomalies(measured_at)
        self._last_abs = measured_at

    def refresh_anomalies(self, snapshot):
        """Sync alarm state from a live snapshot without writing measurements.

        The alarm center calls this when it opens/refreshes so a freshly
        injected fault appears immediately instead of waiting for the next
        scheduled sample.
        """
        sim = snapshot.get("sim") or {}
        measured_at = self._abs_minutes(sim)
        with self.lock:
            self._begin_sample(measured_at)
            self._sync_anomalies(snapshot, measured_at)
        return measured_at

    def _close_active_anomalies(self, at):
        self.conn.execute(
            "UPDATE equipment_anomalies SET active = 0, closed_at = ? WHERE active = 1",
            (at,),
        )

    def _sync_anomalies(self, snapshot, measured_at):
        active = [e for e in snapshot.get("anomalies", [])
                  if e.get("severity") != "operator"]
        seen = set()
        for e in active:
            dev_id = e.get("device_id")
            if not dev_id:
                continue
            key = f"{self._epoch}:{e.get('id')}"
            seen.add((dev_id, key))
            # Re-opening a row that was closed (detector recovered it, and
            # possibly an operator already resolved it) must clear the stale
            # operator close-out: otherwise the record stays "resolved" while
            # the condition is live again and disappears from the Active
            # view. Routine refreshes of a still-active row keep their
            # acknowledgement, so the CASE branches only fire on re-open.
            self.conn.execute(
                """INSERT INTO equipment_anomalies
                     (equipment_id, event_key, opened_at, closed_at,
                      severity, message, active)
                   VALUES (?, ?, ?, NULL, ?, ?, 1)
                   ON CONFLICT(equipment_id, event_key) DO UPDATE SET
                     severity = excluded.severity,
                     message = excluded.message,
                     active = 1,
                     closed_at = NULL,
                     acknowledged_at = CASE WHEN equipment_anomalies.active = 0
                                            THEN NULL ELSE acknowledged_at END,
                     acknowledged_by = CASE WHEN equipment_anomalies.active = 0
                                            THEN NULL ELSE acknowledged_by END,
                     resolved_at = CASE WHEN equipment_anomalies.active = 0
                                        THEN NULL ELSE resolved_at END,
                     resolved_by = CASE WHEN equipment_anomalies.active = 0
                                        THEN NULL ELSE resolved_by END,
                     resolution_note = CASE WHEN equipment_anomalies.active = 0
                                            THEN NULL ELSE resolution_note END""",
                (dev_id, key, int(e.get("ts") or measured_at),
                 e.get("severity", "warning"), e.get("message", "")),
            )
        # Rows still open that the detector no longer reports have recovered.
        open_rows = self.conn.execute(
            "SELECT equipment_id, event_key FROM equipment_anomalies WHERE active = 1"
        ).fetchall()
        for dev_id, key in open_rows:
            if (dev_id, key) not in seen:
                self.conn.execute(
                    "UPDATE equipment_anomalies SET active = 0, closed_at = ? "
                    "WHERE equipment_id = ? AND event_key = ?",
                    (measured_at, dev_id, key),
                )
        self.conn.commit()

    # ---------------- alarm workflow ----------------
    #
    # An alarm is a persisted anomaly plus operator follow-up.  The detector
    # owns active/closed_at; these methods never clear a live condition -
    # "resolve" is only accepted once the anomaly has recovered, so the
    # operator cannot hide an abnormal device behind a resolved record.

    ALARM_STATUSES = ("active", "open", "acknowledged", "recovered",
                      "resolved", "all")
    ALARM_SEVERITIES = ("warning", "serious", "critical")
    _ALARM_SELECT = """
        SELECT a.equipment_id, a.event_key, a.opened_at, a.closed_at,
               a.severity, a.message, a.active,
               a.acknowledged_at, a.acknowledged_by,
               a.resolved_at, a.resolved_by, a.resolution_note,
               e.name, e.category, e.building_id, e.floor_id, e.room_id,
               e.source
          FROM equipment_anomalies a
          JOIN equipment e ON e.id = a.equipment_id
    """

    @staticmethod
    def _clean_operator(value, default="operator"):
        text = str(value or "").strip()
        return text[:40] if text else default

    @staticmethod
    def _clean_note(value):
        return str(value or "").strip()[:500]

    @classmethod
    def _alarm_state(cls, active, acknowledged_at, resolved_at):
        if active:
            return "acknowledged" if acknowledged_at else "open"
        return "resolved" if resolved_at else "recovered"

    @classmethod
    def _alarm_row(cls, r):
        return {
            "equipment_id": r[0],
            "event_key": r[1],
            "opened_at": r[2],
            "closed_at": r[3],
            "severity": r[4],
            "message": r[5],
            "active": bool(r[6]),
            "acknowledged_at": r[7],
            "acknowledged_by": r[8],
            "resolved_at": r[9],
            "resolved_by": r[10],
            "resolution_note": r[11],
            "device_name": r[12],
            "category": r[13],
            "category_label": CATEGORY_LABELS.get(r[13], r[13]),
            "building_id": r[14],
            "floor_id": r[15],
            "room_id": r[16],
            "source": r[17] or "simulated",
            "state": cls._alarm_state(bool(r[6]), r[7], r[9]),
        }

    def list_alarms(self, status="active", severity=None, building_id=None,
                    limit=100):
        if status not in self.ALARM_STATUSES:
            raise ValueError(f"unknown alarm status '{status}'")
        if severity not in (None, "", *self.ALARM_SEVERITIES):
            raise ValueError(f"unknown severity '{severity}'")
        try:
            limit = max(1, min(500, int(limit)))
        except (TypeError, ValueError):
            limit = 100
        clauses = []
        if status == "active":
            clauses.append("a.active = 1")
        elif status == "open":
            clauses.append("a.active = 1 AND a.acknowledged_at IS NULL")
        elif status == "acknowledged":
            clauses.append("a.active = 1 AND a.acknowledged_at IS NOT NULL")
        elif status == "recovered":
            clauses.append("a.active = 0 AND a.resolved_at IS NULL")
        elif status == "resolved":
            clauses.append("a.resolved_at IS NOT NULL")
        # "all" adds no clause
        severity = (severity or "").strip() or None
        building_id = (building_id or "").strip() or None
        if severity:
            clauses.append("a.severity = ?")
        if building_id:
            clauses.append("e.building_id = ?")
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        params = []
        if severity:
            params.append(severity)
        if building_id:
            params.append(building_id)
        params.append(limit)
        sql = (self._ALARM_SELECT + where
               + " ORDER BY a.active DESC, a.opened_at DESC, a.equipment_id"
               + " LIMIT ?")
        with self.lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [self._alarm_row(r) for r in rows]

    def alarm_counts(self):
        with self.lock:
            row = self.conn.execute(
                """SELECT COUNT(*),
                          COALESCE(SUM(CASE WHEN active = 1 AND acknowledged_at IS NULL
                                            THEN 1 ELSE 0 END), 0),
                          COALESCE(SUM(CASE WHEN active = 1 AND acknowledged_at IS NOT NULL
                                            THEN 1 ELSE 0 END), 0),
                          COALESCE(SUM(CASE WHEN active = 0 AND resolved_at IS NULL
                                            THEN 1 ELSE 0 END), 0),
                          COALESCE(SUM(CASE WHEN resolved_at IS NOT NULL
                                            THEN 1 ELSE 0 END), 0)
                     FROM equipment_anomalies"""
            ).fetchone()
        counts = {
            "open": int(row[1]), "acknowledged": int(row[2]),
            "recovered": int(row[3]), "resolved": int(row[4]),
            "total": int(row[0]),
        }
        counts["active"] = counts["open"] + counts["acknowledged"]
        return counts

    def _get_alarm(self, equipment_id, event_key):
        with self.lock:
            row = self.conn.execute(
                self._ALARM_SELECT
                + " WHERE a.equipment_id = ? AND a.event_key = ?",
                (equipment_id, event_key),
            ).fetchone()
        return self._alarm_row(row) if row else None

    def acknowledge_alarm(self, equipment_id, event_key, operator=None):
        """Take ownership of an active alarm; idempotent while active."""
        if not equipment_id or not event_key:
            return None
        with self.lock:
            row = self.conn.execute(
                """SELECT active, acknowledged_at FROM equipment_anomalies
                    WHERE equipment_id = ? AND event_key = ?""",
                (equipment_id, event_key),
            ).fetchone()
            if row is None:
                return None
            if not row[0]:
                raise ValueError("alarm has recovered; acknowledge is no longer possible")
            if row[1] is None:
                self.conn.execute(
                    """UPDATE equipment_anomalies
                          SET acknowledged_at = datetime('now'), acknowledged_by = ?
                        WHERE equipment_id = ? AND event_key = ?""",
                    (self._clean_operator(operator), equipment_id, event_key),
                )
                self.conn.commit()
        return self._get_alarm(equipment_id, event_key)

    def resolve_alarm(self, equipment_id, event_key, operator=None, note=None):
        """Close the record of a recovered alarm; active conditions are refused."""
        if not equipment_id or not event_key:
            return None
        with self.lock:
            row = self.conn.execute(
                """SELECT active, resolved_at FROM equipment_anomalies
                    WHERE equipment_id = ? AND event_key = ?""",
                (equipment_id, event_key),
            ).fetchone()
            if row is None:
                return None
            if row[0]:
                raise ValueError(
                    "condition is still active; resolve it only after recovery")
            if row[1] is None:
                self.conn.execute(
                    """UPDATE equipment_anomalies
                          SET resolved_at = datetime('now'), resolved_by = ?,
                              resolution_note = ?
                        WHERE equipment_id = ? AND event_key = ?""",
                    (self._clean_operator(operator), self._clean_note(note),
                     equipment_id, event_key),
                )
                self.conn.commit()
        return self._get_alarm(equipment_id, event_key)

    # ---------------- reads ----------------

    def list_equipment(self):
        """Registry joined with each device's latest canonical measurement."""
        rows = self.conn.execute(
            """SELECT e.id, e.name, e.category, e.building_id, e.floor_id,
                      e.room_id, e.rated_kw, e.source, e.attributes,
                      m.actual_kw, m.expected_kw, m.energy_today_kwh,
                      m.operating_hours, m.status, m.measured_at,
                      m.measured_day, m.measured_time, m.sensors,
                      m.source AS measurement_source,
                      (SELECT COUNT(*) FROM equipment_anomalies a
                        WHERE a.equipment_id = e.id AND a.active = 1) AS active_anomalies
                 FROM equipment e
                 LEFT JOIN equipment_measurements m
                   ON m.equipment_id = e.id
                  AND m.measured_at = (SELECT MAX(measured_at)
                                         FROM equipment_measurements
                                        WHERE equipment_id = e.id)
                ORDER BY COALESCE(e.building_id, ''),
                         COALESCE(e.floor_id, ''),
                         e.category, e.id"""
        ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def equipment_detail(self, equipment_id, history=100):
        row = self.conn.execute(
            """SELECT id, name, category, building_id, floor_id, room_id,
                      rated_kw, source, attributes
                 FROM equipment WHERE id = ?""",
            (equipment_id,),
        ).fetchone()
        if row is None:
            return None
        item = {
            "id": row[0], "name": row[1], "category": row[2],
            "category_label": CATEGORY_LABELS.get(row[2], row[2]),
            "parent": {"building": row[3], "floor": row[4], "room": row[5]},
            "rated_kw": row[6], "source": row[7],
            "attributes": json.loads(row[8] or "{}"),
        }
        measurements = self.conn.execute(
            """SELECT measured_at, measured_day, measured_time, actual_kw,
                      expected_kw, energy_today_kwh, operating_hours, status,
                      source, sensors
                 FROM equipment_measurements
                WHERE equipment_id = ?
                ORDER BY measured_at DESC LIMIT ?""",
            (equipment_id, int(history)),
        ).fetchall()
        # the query is ordered newest first, so measurements[0] is current
        item["latest"] = self._measurement(measurements[0]) if measurements else None
        item["history"] = [self._measurement(m) for m in reversed(measurements)]
        anomalies = self.conn.execute(
            """SELECT event_key, opened_at, closed_at, severity, message, active,
                      acknowledged_at, acknowledged_by, resolved_at,
                      resolved_by, resolution_note
                 FROM equipment_anomalies
                WHERE equipment_id = ?
                ORDER BY opened_at DESC LIMIT 50""",
            (equipment_id,),
        ).fetchall()
        item["anomalies"] = [
            {"event_key": a[0], "opened_at": a[1], "closed_at": a[2],
             "severity": a[3], "message": a[4], "active": bool(a[5]),
             "state": self._alarm_state(bool(a[5]), a[6], a[8]),
             "acknowledged_at": a[6], "acknowledged_by": a[7],
             "resolved_at": a[8], "resolved_by": a[9],
             "resolution_note": a[10]}
            for a in anomalies
        ]
        item["scenario"] = self.get_scenario(equipment_id)
        return item

    @staticmethod
    def _measurement(row):
        return {
            "measured_at": row[0], "measured_day": row[1], "measured_time": row[2],
            "actual_kw": row[3], "expected_kw": row[4],
            "energy_today_kwh": row[5], "operating_hours": row[6],
            "status": row[7], "source": row[8],
            "sensors": json.loads(row[9] or "{}"),
        }

    @classmethod
    def _row_to_dict(cls, r):
        return {
            "id": r[0], "name": r[1], "category": r[2],
            "category_label": CATEGORY_LABELS.get(r[2], r[2]),
            "parent": {"building": r[3], "floor": r[4], "room": r[5]},
            "rated_kw": r[6], "source": r[7],
            "attributes": json.loads(r[8] or "{}"),
            "latest": {
                "actual_kw": r[9], "expected_kw": r[10],
                "energy_today_kwh": r[11], "operating_hours": r[12],
                "status": r[13], "measured_at": r[14],
                "measured_day": r[15], "measured_time": r[16],
                "sensors": json.loads(r[17] or "{}"),
                "source": r[18],
            } if r[14] is not None else None,
            "active_anomalies": r[19] or 0,
        }

    def stats(self):
        stats = {}
        with self.lock:
            stats["equipment"] = self.conn.execute(
                "SELECT COUNT(*) FROM equipment").fetchone()[0]
            stats["measurements"] = self.conn.execute(
                "SELECT COUNT(*) FROM equipment_measurements").fetchone()[0]
            stats["open_anomalies"] = self.conn.execute(
                "SELECT COUNT(*) FROM equipment_anomalies WHERE active = 1").fetchone()[0]
            stats["schema_version"] = self.schema_version
            stats["db_path"] = str(self.path)
        return stats

    def close(self):
        with self.lock:
            self.conn.close()
