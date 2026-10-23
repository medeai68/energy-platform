"""Equipment data model: registry, measurements and anomaly persistence.

Acceptance criteria covered:
  - stable equipment id, name, category, parent building/floor/room ids
  - rated kW, operating status, operating hours, energy kWh, timestamp
  - data source (live / imported / simulated), sensor readings, attributes
  - versioned migrations (incl. adopting a pre-migration database)
  - one canonical measurement per (equipment, timestamp): no duplicates
  - anomaly records open/close in place and survive a simulation reset
"""

import sqlite3
import tempfile
import unittest
from pathlib import Path

from equipment.migrations import apply_migrations, current_version
from equipment.model import Equipment, Measurement
from equipment.store import EquipmentStore
from sim.engine import SimulationEngine

LEGACY_DDL = """CREATE TABLE intelligence_snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts REAL NOT NULL,
     day INTEGER,
     sim_time TEXT,
     health_score REAL,
     payload TEXT NOT NULL
   )"""


class EquipmentStoreBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = str(Path(self.tmp.name) / "equipment.db")
        self.store = EquipmentStore(self.db)
        self.addCleanup(self._close_store)
        self.eng = SimulationEngine()

    def _close_store(self):
        try:
            self.store.close()
        except sqlite3.ProgrammingError:
            pass  # already closed by a test

    def tick(self, n):
        for _ in range(n):
            self.eng.tick()

    def register_and_sample(self):
        snap = self.eng.snapshot()
        self.store.sync_registry(snap)
        self.store.record_sample(snap)
        return snap

    def query(self, sql, params=()):
        return self.store.conn.execute(sql, params).fetchall()


class TestMigrations(EquipmentStoreBase):
    def test_fresh_database_gets_full_schema(self):
        self.assertEqual(self.store.schema_version, 5)
        tables = {r[0] for r in self.query(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"schema_migrations", "intelligence_snapshots",
                         "equipment", "equipment_measurements",
                         "equipment_anomalies", "equipment_scenarios"} <= tables)
        applied = self.query("SELECT version, name FROM schema_migrations ORDER BY version")
        self.assertEqual([r[0] for r in applied], [1, 2, 3, 4, 5])
        columns = {r[1] for r in self.query("PRAGMA table_info(equipment_scenarios)")}
        self.assertTrue({"rated_kw", "operating_hours", "load_factor",
                         "schedule_start"} <= columns)
        alarm_columns = {r[1] for r in self.query(
            "PRAGMA table_info(equipment_anomalies)")}
        self.assertTrue({"acknowledged_at", "acknowledged_by", "resolved_at",
                         "resolved_by", "resolution_note"} <= alarm_columns)

    def test_migrations_are_idempotent(self):
        version = apply_migrations(self.store.conn)
        self.assertEqual(version, 5)
        # a second store on the same file must not re-run or duplicate rows
        other = EquipmentStore(self.db)
        try:
            self.assertEqual(other.schema_version, 5)
            rows = other.conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]
            self.assertEqual(rows, 5)
        finally:
            other.close()

    def test_legacy_database_is_adopted_without_data_loss(self):
        legacy = str(Path(self.tmp.name) / "legacy.db")
        conn = sqlite3.connect(legacy)
        conn.execute(LEGACY_DDL)
        conn.execute(
            "INSERT INTO intelligence_snapshots(ts,day,sim_time,health_score,payload) "
            "VALUES(datetime('now'),1,'06:00',90.0,'{}')")
        conn.commit()
        self.assertEqual(current_version(conn), 0)
        self.assertEqual(apply_migrations(conn), 5)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM intelligence_snapshots").fetchone()[0], 1)
        conn.close()


class TestRegistry(EquipmentStoreBase):
    def test_every_device_is_registered_with_identity_and_parents(self):
        self.tick(2)
        snap = self.register_and_sample()
        n = self.store.stats()["equipment"]
        self.assertEqual(n, len(snap["devices"]) + len(snap["panels"])
                         + len(snap["equipment"]))
        self.assertEqual(n, 100)  # 7 aggregates + 48 panels + 45 leaves

        by_id = {e["id"]: e for e in self.store.list_equipment()}
        ups = by_id["ups-b1"]
        self.assertEqual(ups["name"], "Server UPS")
        self.assertEqual(ups["category"], "server_ups")
        self.assertEqual(ups["parent"], {"building": "b1", "floor": "b1f2",
                                         "room": "b1f2r2"})
        self.assertGreater(ups["rated_kw"], 0)
        self.assertEqual(ups["source"], "simulated")
        self.assertEqual(ups["attributes"]["serves"], "server room")

        panel = by_id["p01"]
        self.assertEqual(panel["category"], "panel")
        self.assertEqual(panel["parent"]["building"], "b1")
        self.assertIsNone(panel["parent"]["floor"])
        self.assertEqual(panel["attributes"]["row"], 1)

        fcu = by_id["fc-b1f1"]
        self.assertEqual(fcu["parent"], {"building": "b1", "floor": "b1f1",
                                         "room": None})
        self.assertEqual(fcu["attributes"]["serves_floor"], "b1f1")

        # campus-level aggregates have no parent building
        self.assertIsNone(by_id["hvac"]["parent"]["building"])

    def test_registry_resync_updates_in_place(self):
        snap = self.eng.snapshot()
        snap["equipment"][0]["name"] = "Renamed FCU"
        self.store.sync_registry(snap)
        self.store.sync_registry(snap)
        rows = self.query("SELECT name FROM equipment WHERE id = ?",
                          (snap["equipment"][0]["id"],))
        self.assertEqual(rows, [("Renamed FCU",)])


class TestMeasurements(EquipmentStoreBase):
    def test_same_timestamp_is_one_canonical_row(self):
        self.tick(1)
        snap = self.eng.snapshot()
        self.store.sync_registry(snap)
        self.store.record_sample(snap)          # first write
        dev = snap["equipment"][0]
        dev["actual"] = 123.45                  # corrected reading, same time
        self.store.record_sample(snap)          # must update, not duplicate
        rows = self.query(
            "SELECT actual_kw, measured_at FROM equipment_measurements "
            "WHERE equipment_id = ?", (dev["id"],))
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0][0], 123.45)

    def test_measurements_carry_the_full_model(self):
        self.tick(3)  # 06:00 -> 09:00
        self.register_and_sample()
        item = self.store.equipment_detail("fc-b1f1")
        latest = item["latest"]
        self.assertEqual(latest["measured_day"], 1)
        self.assertEqual(latest["measured_time"], "09:00")
        self.assertEqual(latest["source"], "simulated")
        self.assertEqual(latest["status"], "ok")
        self.assertIn("duty", latest["sensors"])
        self.assertGreater(latest["actual_kw"], 0)
        self.assertIsNotNone(latest["expected_kw"])

        energy = self.store.equipment_detail("hvac")["latest"]
        self.assertGreater(energy["energy_today_kwh"], 0)
        self.assertGreater(energy["operating_hours"], 0)

    def test_distinct_timestamps_accumulate_history(self):
        self.tick(1)
        self.register_and_sample()
        self.tick(2)  # 07:00 -> 09:00
        self.register_and_sample()
        hist = self.store.equipment_detail("hvac", history=10)["history"]
        self.assertEqual([h["measured_time"] for h in hist], ["07:00", "09:00"])
        self.assertGreaterEqual(hist[1]["energy_today_kwh"], hist[0]["energy_today_kwh"])
        self.assertGreaterEqual(hist[1]["operating_hours"], hist[0]["operating_hours"])

    def test_unknown_equipment_returns_none(self):
        self.assertIsNone(self.store.equipment_detail("nope"))

    def test_availability_tracks_source_and_age(self):
        """The data-availability mode reads wall-clock age + source per device."""
        self.register_and_sample()
        avail = self.store.availability()
        self.assertEqual(len(avail), 100)
        self.assertIn("ups-b1", avail)
        self.assertEqual(avail["ups-b1"]["source"], "simulated")
        self.assertLess(avail["ups-b1"]["age_seconds"], 5.0)
        # a live reading updates the source for that equipment
        self.store.import_measurement(
            "p20", measured_at=9000, measured_day=7, measured_time="06:00",
            actual_kw=0.4, source="live", sensors={"voltage": 33.0})
        avail = self.store.availability()
        self.assertEqual(avail["p20"]["source"], "live")
        self.assertLess(avail["p20"]["age_seconds"], 5.0)

    def test_imported_measurements_use_the_same_canonical_row(self):
        self.register_and_sample()
        self.store.import_measurement(
            "p01", measured_at=5000, measured_day=4, measured_time="07:20",
            actual_kw=1.2, expected_kw=1.3, source="imported",
            sensors={"voltage": 33.1, "current": 36.2})
        latest = self.store.equipment_detail("p01")["latest"]
        self.assertEqual(latest["source"], "imported")
        self.assertEqual(latest["sensors"]["voltage"], 33.1)
        # correcting the same imported timestamp updates in place
        self.store.import_measurement(
            "p01", measured_at=5000, measured_day=4, measured_time="07:20",
            actual_kw=1.25, expected_kw=1.3, source="imported")
        rows = self.query(
            "SELECT actual_kw FROM equipment_measurements "
            "WHERE equipment_id='p01' AND measured_at=5000")
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0][0], 1.25)
        # unknown equipment and invalid enums are rejected
        with self.assertRaises(ValueError):
            self.store.import_measurement("nope", 1, 1, "06:00")
        with self.assertRaises(ValueError):
            self.store.import_measurement("p01", 5001, 4, "07:21", source="guess")

    def test_model_validation(self):
        with self.assertRaises(ValueError):
            Equipment(id="x", name="X", category="fcu", source="magic")
        with self.assertRaises(ValueError):
            Measurement(equipment_id="x", measured_at=1, measured_day=1,
                        measured_time="06:00", actual_kw=0, expected_kw=0,
                        energy_today_kwh=0, operating_hours=0,
                        status="fine", source="simulated")


class TestAnomalies(EquipmentStoreBase):
    def test_anomaly_opens_and_closes_in_place(self):
        self.tick(6)  # midday, panels generating
        self.eng.set_fault("p01", "reduced_output", True)
        self.tick(3)  # detector raises after 2 sustained ticks
        self.register_and_sample()
        active = self.query(
            "SELECT severity, message, active FROM equipment_anomalies "
            "WHERE equipment_id = 'p01' AND active = 1")
        self.assertEqual(len(active), 1)
        self.assertIn("Panel P-01", active[0][1])

        self.eng.set_fault("p01", "reduced_output", False)
        self.tick(5)  # recovery needs 3 consecutive in-bounds ticks
        snap = self.eng.snapshot()
        self.store.record_sample(snap)
        rows = self.query(
            "SELECT active, closed_at FROM equipment_anomalies "
            "WHERE equipment_id = 'p01' ORDER BY opened_at DESC")
        self.assertEqual(len(rows), 1, "anomaly must be updated, not duplicated")
        self.assertEqual(rows[0][0], 0)
        self.assertIsNotNone(rows[0][1])

    def test_operator_events_are_not_anomalies(self):
        self.tick(2)
        self.eng.set_fault("fc-b1f1", "overconsumption", True)
        self.register_and_sample()
        rows = self.query(
            "SELECT message FROM equipment_anomalies WHERE equipment_id = 'fc-b1f1'")
        for (message,) in rows:
            self.assertNotIn("Injected virtual fault", message)

    def test_reset_closes_active_anomalies_and_starts_new_epoch(self):
        self.tick(6)
        self.eng.set_fault("p02", "overheating", True)
        self.tick(3)
        self.register_and_sample()
        self.assertEqual(self.store.stats()["open_anomalies"], 1)
        self.eng.reset()  # sim time jumps back to day 1 06:00
        self.tick(1)
        self.register_and_sample()
        self.assertEqual(self.store.stats()["open_anomalies"], 0)
        closed = self.query(
            "SELECT active, closed_at FROM equipment_anomalies WHERE equipment_id='p02'")
        self.assertEqual(closed[0][0], 0)
        self.assertIsNotNone(closed[0][1])

    def test_active_anomaly_count_is_exposed(self):
        self.tick(6)
        self.eng.set_fault("p03", "disconnected", True)
        self.tick(3)
        self.register_and_sample()
        by_id = {e["id"]: e for e in self.store.list_equipment()}
        self.assertGreaterEqual(by_id["p03"]["active_anomalies"], 1)
        self.assertEqual(by_id["p04"]["active_anomalies"], 0)
        detail = self.store.equipment_detail("p03")
        self.assertTrue(any(a["active"] for a in detail["anomalies"]))


class TestScenarios(EquipmentStoreBase):
    """Scenario configuration for simulated equipment (Step 7)."""

    def test_scenario_roundtrip_persists_and_calculates(self):
        self.register_and_sample()
        saved = self.store.set_scenario("ups-b1", 6.0, 8.0)
        self.assertEqual(saved["equipment_id"], "ups-b1")
        self.assertEqual(saved["source"], "simulated")
        self.assertAlmostEqual(saved["daily_energy_kwh"], 48.0)
        self.assertAlmostEqual(saved["monthly_energy_kwh"], 1440.0)
        self.assertEqual(saved["basis"], "calculated")
        self.assertEqual(saved["formula"], "E = P × t")

        # read back through both store APIs
        self.assertAlmostEqual(self.store.get_scenario("ups-b1")["rated_kw"], 6.0)
        detail = self.store.equipment_detail("ups-b1")
        self.assertAlmostEqual(detail["scenario"]["operating_hours"], 8.0)
        self.assertAlmostEqual(detail["scenario"]["daily_energy_kwh"], 48.0)

        # repeated saves update the single row
        self.store.set_scenario("ups-b1", 5.5, 10.0)
        rows = self.query(
            "SELECT rated_kw, operating_hours FROM equipment_scenarios "
            "WHERE equipment_id='ups-b1'")
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0][0], 5.5)
        self.assertAlmostEqual(rows[0][1], 10.0)

        self.assertTrue(self.store.clear_scenario("ups-b1"))
        self.assertIsNone(self.store.get_scenario("ups-b1"))
        self.assertFalse(self.store.clear_scenario("ups-b1"))

    def test_scenario_load_factor_and_schedule_roundtrip(self):
        self.register_and_sample()
        saved = self.store.set_scenario("ups-b1", 10.0, 8.0, 0.5, 9.0)
        self.assertAlmostEqual(saved["rated_kw"], 10.0)
        self.assertAlmostEqual(saved["load_factor"], 0.5)
        self.assertAlmostEqual(saved["effective_power_kw"], 5.0)
        self.assertAlmostEqual(saved["daily_energy_kwh"], 40.0)
        self.assertAlmostEqual(saved["monthly_energy_kwh"], 1200.0)
        self.assertEqual(saved["formula"], "E = P × t × LF")
        self.assertEqual(saved["schedule_label"], "09:00–17:00")
        self.assertEqual(saved["basis"], "calculated")

        detail = self.store.equipment_detail("ups-b1")["scenario"]
        self.assertAlmostEqual(detail["load_factor"], 0.5)
        self.assertAlmostEqual(detail["schedule_start"], 9.0)
        rows = self.query(
            "SELECT load_factor, schedule_start FROM equipment_scenarios "
            "WHERE equipment_id='ups-b1'")
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0][0], 0.5)
        self.assertAlmostEqual(rows[0][1], 9.0)

        # defaults restore the Step 7 result exactly
        saved = self.store.set_scenario("ups-b1", 6.0, 8.0)
        self.assertAlmostEqual(saved["daily_energy_kwh"], 48.0)
        self.assertAlmostEqual(saved["load_factor"], 1.0)
        self.assertAlmostEqual(saved["schedule_start"], 0.0)
        self.assertEqual(saved["formula"], "E = P × t")

    def test_scenario_load_factor_and_schedule_validation(self):
        self.register_and_sample()
        for kwargs in ({"load_factor": 1.1}, {"load_factor": -0.1},
                       {"schedule_start": 17.0, "operating_hours": 8.0},
                       {"schedule_start": -1.0}):
            args = dict(rated_kw=6.0, operating_hours=8.0)
            args.update(kwargs)
            with self.assertRaises(ValueError):
                self.store.set_scenario("ups-b1", **args)
        self.assertEqual(self.query(
            "SELECT COUNT(*) FROM equipment_scenarios")[0][0], 0)

    def test_scenario_defaults_to_none(self):
        self.register_and_sample()
        self.assertIsNone(self.store.get_scenario("fc-b1f1"))
        self.assertIsNone(self.store.equipment_detail("fc-b1f1")["scenario"])

    def test_scenario_rejects_live_or_imported_equipment(self):
        self.register_and_sample()
        self.store.conn.execute(
            "UPDATE equipment SET source='imported' WHERE id='ups-b1'")
        self.store.conn.commit()
        with self.assertRaises(ValueError) as ctx:
            self.store.set_scenario("ups-b1", 6.0, 8.0)
        self.assertIn("simulated", str(ctx.exception))
        # nothing was written
        self.assertEqual(self.query(
            "SELECT COUNT(*) FROM equipment_scenarios")[0][0], 0)

    def test_scenario_input_validation(self):
        self.register_and_sample()
        with self.assertRaises(ValueError):
            self.store.set_scenario("nope", 6.0, 8.0)
        with self.assertRaises(ValueError):
            self.store.set_scenario("ups-b1", -1, 8.0)
        with self.assertRaises(ValueError):
            self.store.set_scenario("ups-b1", 6.0, 25.0)
        with self.assertRaises(ValueError):
            self.store.set_scenario("ups-b1", "six", 8.0)


if __name__ == "__main__":
    unittest.main()
