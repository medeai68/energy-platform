"""Backend audit regressions: reset safety, units, validation and read-only GETs.

These tests are fully offline. The HTTP tests start the project's real
``ThreadingHTTPServer``/``Handler`` on an ephemeral loopback port and replace
its module-level engine/store with isolated temp-database instances, so the
running development server and the production database are never contacted.

Covered defects:
  - ``SimulationEngine.reset`` replaced its own lock mid-reset, and the store
    could miss a reset when sim time caught up before the next sample.
  - Sensor-layer faults injected on aggregate devices were accepted but never
    applied.
  - The intelligence sensor-health score ignored live sensor faults.
  - Live/imported measurement timestamps (Unix seconds) were integrated as if
    they were minutes.
  - ``/api/ai/diagnose`` fabricated a warning when no anomaly existed.
  - GET ``/api/intelligence`` and ``/api/alarms`` wrote to the database.
  - POST bodies were unbounded and control/fault values were not validated.
"""

import http.client
import json
import os
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from equipment.store import EquipmentStore
from intelligence.engine import EnergyIntelligence
from intelligence.metrics import calculate
from sim.engine import SimulationEngine

# server.py builds its module-level engine/store at import time. Point that
# import at a throw-away file before importing it so the test run can never
# create or touch data/energy_intelligence.db.
_IMPORT_ROOT = tempfile.mkdtemp(prefix="ep-backend-import-")
_ORIGINAL_DB_ENV = os.environ.get("ENERGY_DB_PATH")
os.environ["ENERGY_DB_PATH"] = str(Path(_IMPORT_ROOT) / "import.db")
import server  # noqa: E402  (must follow the environment override)


def tearDownModule():
    """Close the import-time stores and remove their temp database."""
    try:
        for obj in (server.equipment_store, server.intelligence):
            try:
                obj.close()
            except Exception:
                pass
    finally:
        if _ORIGINAL_DB_ENV is None:
            os.environ.pop("ENERGY_DB_PATH", None)
        else:
            os.environ["ENERGY_DB_PATH"] = _ORIGINAL_DB_ENV
        shutil.rmtree(_IMPORT_ROOT, ignore_errors=True)


class _QuietHandler(server.Handler):
    def log_message(self, fmt, *args):
        pass


class BackendTestBase(unittest.TestCase):
    """Ephemeral HTTP server + fresh isolated engine/store per test."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), _QuietHandler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(
            target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(5)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = str(Path(self.tmp.name) / "backend.db")
        self.engine = SimulationEngine()
        self.store = EquipmentStore(self.db)
        self.intel = EnergyIntelligence(db_path=self.db)
        self.addCleanup(self._close_isolated)
        self._orig = (server.engine, server.equipment_store, server.intelligence)
        server.engine = self.engine
        server.equipment_store = self.store
        server.intelligence = self.intel

    def _close_isolated(self):
        server.engine, server.equipment_store, server.intelligence = self._orig
        for obj in (self.store, self.intel):
            try:
                obj.close()
            except Exception:
                pass

    def http(self, method, path, payload=None, raw_body=None,
             declared_length=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {}
        body = None
        if raw_body is not None:
            body = raw_body
            headers["Content-Length"] = str(len(body))
            headers["Content-Type"] = "application/json"
        elif payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Length"] = str(len(body))
            headers["Content-Type"] = "application/json"
        if declared_length is not None:
            headers["Content-Length"] = str(declared_length)
        conn.request(method, path, body=body, headers=headers)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        try:
            parsed = json.loads(data) if data else None
        except ValueError:
            parsed = None
        return res.status, parsed

    def count(self, table):
        return self.store.conn.execute(
            f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    def tick(self, n):
        for _ in range(n):
            self.engine.tick()


class TestResetSafety(BackendTestBase):
    def test_reset_keeps_the_lock_and_bumps_the_reset_sequence(self):
        lock = self.engine.lock
        seq = self.engine.snapshot()["sim"]["reset_seq"]
        self.engine.reset()
        self.assertIs(self.engine.lock, lock,
                      "reset must not replace the lock other threads wait on")
        self.assertEqual(self.engine.snapshot()["sim"]["reset_seq"], seq + 1)

    def test_store_closes_anomalies_when_sim_time_catches_up_after_reset(self):
        """The old detector only noticed backward timestamps.

        After a reset the engine can advance past the previous sample before
        the next 10 s sample is taken; event ids then restart at 1 and can
        collide with the old epoch. The reset sequence closes that gap.
        """
        self.engine.minutes = 720
        self.engine.set_fault("p01", "disconnected", True)
        self.tick(3)
        snap = self.engine.snapshot(full_anomalies=True)
        self.store.sync_registry(snap)
        self.store.record_sample(snap)
        self.assertEqual(self.store.stats()["open_anomalies"], 1)
        self.engine.reset()
        # Catch up past the previous measured_at (~900) before sampling.
        self.tick(10)
        snap = self.engine.snapshot(full_anomalies=True)
        self.assertGreater(self.store._abs_minutes(snap["sim"]),
                           self.store._last_abs)
        self.store.record_sample(snap)
        self.assertEqual(self.store._epoch, 1)
        self.assertEqual(self.store.stats()["open_anomalies"], 0)

        # A new event after the reset gets a fresh epoch-qualified key.
        self.engine.set_fault("p01", "disconnected", True)
        self.tick(3)
        snap = self.engine.snapshot(full_anomalies=True)
        self.store.record_sample(snap)
        keys = [r[0] for r in self.store.conn.execute(
            "SELECT event_key FROM equipment_anomalies WHERE equipment_id='p01'")]
        self.assertEqual(len(keys), 2)
        self.assertEqual({k.split(":", 1)[0] for k in keys}, {"0", "1"},
                         "the post-reset event must not reuse the old epoch key")
        self.assertNotEqual(keys[0], keys[1])

    def test_full_snapshot_keeps_alarms_outside_the_dashboard_top_ten(self):
        for i in range(1, 13):
            self.engine._add_event(
                "warning", f"p{i:02d}", f"Panel P-{i:02d}",
                f"test anomaly {i}", active=True)
        default = self.engine.snapshot()
        full = self.engine.snapshot(full_anomalies=True)
        self.assertEqual(len(default["anomalies"]), 10)
        self.assertEqual(len(full["anomalies"]), 12)

        self.store.sync_registry(full)
        self.store.refresh_anomalies(full)
        self.assertEqual(self.store.stats()["open_anomalies"], 12)
        self.assertEqual(len(self.store.list_alarms(status="active", limit=500)), 12)


class TestAggregateSensorFaults(BackendTestBase):
    def test_sensor_drift_on_hvac_distorts_its_own_measurement(self):
        self.engine.minutes = 720
        self.engine.tick()
        self.assertTrue(self.engine.set_fault("hvac", "sensor_drift", True))
        self.engine.tick()
        self.engine.tick()
        snap = self.engine.snapshot()
        hvac = next(d for d in snap["devices"] if d["id"] == "hvac")
        leaves = [d for d in snap["equipment"] if d["kind"] == "fcu"]
        healthy_sum = sum(d["actual"] for d in leaves)
        self.assertAlmostEqual(hvac["actual"], healthy_sum * 1.35, delta=0.3)
        self.assertIn("sensor_drift",
                      [f["id"] for f in hvac["faults"]])

    def test_sensor_stuck_on_lighting_freezes_its_reading(self):
        self.engine.minutes = 720
        self.engine.tick()
        self.assertTrue(self.engine.set_fault("lighting", "sensor_stuck", True))
        self.engine.tick()
        snap = self.engine.snapshot()
        frozen = next(d for d in snap["devices"] if d["id"] == "lighting")["actual"]
        self.engine.minutes = 900  # different hour -> healthy value changes
        self.engine.tick()
        later = next(d for d in self.engine.snapshot()["devices"]
                     if d["id"] == "lighting")["actual"]
        self.assertAlmostEqual(later, frozen, places=1)

    def test_sensor_drift_on_inverter_is_applied(self):
        self.engine.minutes = 720
        self.engine.tick()
        self.assertTrue(self.engine.set_fault("inverter", "sensor_drift", True))
        self.engine.tick()
        self.engine.tick()
        inverter = next(d for d in self.engine.snapshot()["devices"]
                        if d["id"] == "inverter")
        self.assertAlmostEqual(inverter["actual"], inverter["expected"] * 1.35,
                               delta=max(1.0, inverter["expected"] * 0.1))
        self.assertIn("sensor_drift",
                      [f["id"] for f in inverter["faults"]])


class TestSensorHealth(BackendTestBase):
    def test_injected_sensor_fault_lowers_sensor_health(self):
        snapshot = {
            "sim": {"day": 1, "time": "12:00"},
            "kpis": {"today": {}},
            "devices": [{"id": "hvac", "kind": "hvac", "actual": 5.0,
                         "expected": 5.0, "status": "ok", "faults": [],
                         "extra": {}}],
            "panels": [],
            "equipment": [
                {"id": "lt-b1f1r1", "kind": "room_light", "actual": 1.0,
                 "expected": 1.0, "status": "serious", "extra": {},
                 "faults": [{"id": "sensor_drift", "layer": "sensor"}]},
                {"id": "lt-b1f1r2", "kind": "room_light", "actual": 1.0,
                 "expected": 1.0, "status": "ok", "faults": [], "extra": {}},
            ],
        }
        result = calculate(snapshot)
        self.assertEqual(result["health_components"]["sensors"], 80.0)

    def test_dataset_sensor_flags_still_penalize_sensor_health(self):
        snapshot = {
            "sim": {}, "kpis": {}, "panels": [], "equipment": [],
            "devices": [{"id": "hvac", "kind": "hvac", "actual": 1.0,
                         "expected": 1.0, "status": "ok", "faults": [],
                         "extra": {"sensor_flags": ["sensor_dropout"]}}],
        }
        result = calculate(snapshot)
        self.assertEqual(result["health_components"]["sensors"], 65.0)


class TestHttpValidation(BackendTestBase):
    def test_oversized_body_is_rejected_before_reading(self):
        status, body = self.http(
            "POST", "/api/control", declared_length=server.MAX_BODY_BYTES + 1)
        self.assertEqual(status, 400)
        self.assertIn("too large", body["error"])

    def test_non_object_json_is_rejected(self):
        status, body = self.http(
            "POST", "/api/control", raw_body=b"[1, 2, 3]")
        self.assertEqual(status, 400)
        self.assertIn("object", body["error"])

    def test_invalid_control_values_are_rejected_without_changing_state(self):
        for payload, message in (
            ({"action": "speed", "value": "fast"}, "speed"),
            ({"action": "speed", "value": 0}, "speed"),
            ({"action": "pause", "value": "false"}, "pause"),
            ({"action": "weather", "value": "hail"}, "weather"),
        ):
            status, body = self.http("POST", "/api/control", payload)
            self.assertEqual(status, 400, payload)
            self.assertIn(message, body["error"])
        self.assertEqual(self.engine.speed, 60)
        self.assertFalse(self.engine.paused)
        self.assertEqual(self.engine.weather.mode, "auto")

    def test_valid_control_values_still_apply(self):
        for payload in ({"action": "speed", "value": 120},
                        {"action": "pause", "value": True},
                        {"action": "weather", "value": "clear"}):
            status, body = self.http("POST", "/api/control", payload)
            self.assertEqual(status, 200)
            self.assertTrue(body["ok"])
        self.assertEqual(self.engine.speed, 120)
        self.assertTrue(self.engine.paused)
        self.assertEqual(self.engine.weather.mode, "clear")

    def test_fault_mutation_requires_typed_fields(self):
        status, body = self.http(
            "POST", "/api/fault",
            {"device_id": ["p01"], "fault_id": "soiling", "active": True})
        self.assertEqual(status, 400)
        self.assertIn("device_id", body["error"])
        status, body = self.http(
            "POST", "/api/fault",
            {"device_id": "p01", "fault_id": "soiling", "active": "false"})
        self.assertEqual(status, 400)
        self.assertIn("active", body["error"])


class TestDiagnoseDoesNotFabricate(BackendTestBase):
    def test_healthy_device_has_no_anomaly_and_no_invented_warning(self):
        status, body = self.http(
            "POST", "/api/ai/diagnose", {"device_id": "hvac"})
        self.assertEqual(status, 200)
        self.assertIsNone(body["anomaly"])
        self.assertIn("no significant deviation", body["diagnosis"]["summary"])
        self.assertNotIn("Current residual outside", json.dumps(body))

    def test_real_active_anomaly_is_still_diagnosed(self):
        self.engine.minutes = 720
        self.engine.set_fault("p01", "disconnected", True)
        self.tick(3)
        full = self.engine.snapshot(full_anomalies=True)
        self.store.sync_registry(full)
        self.store.record_sample(full)
        captured = {}

        def fake_diagnose(device, event, rel):
            captured["device"] = device
            captured["event"] = event
            return {"engine": "test", "summary": "stub", "causes": ["checked"]}

        # The production path may call the optional Claude API when a real
        # residual exists; stub it so this regression stays offline.
        with mock.patch.object(server, "diagnose", fake_diagnose):
            status, body = self.http(
                "POST", "/api/ai/diagnose", {"device_id": "p01"})
        self.assertEqual(status, 200)
        self.assertIsNotNone(body["anomaly"])
        self.assertEqual(captured["event"]["device_id"], "p01")
        self.assertEqual(captured["device"]["id"], "p01")
        self.assertEqual(body["diagnosis"]["causes"], ["checked"])


class TestReadOnlyGets(BackendTestBase):
    def test_intelligence_get_does_not_persist_a_snapshot(self):
        before = self.count("intelligence_snapshots")
        for _ in range(3):
            status, body = self.http("GET", "/api/intelligence")
            self.assertEqual(status, 200)
            self.assertIn("health_score", body)
        self.assertEqual(self.count("intelligence_snapshots"), before)

    def test_alarm_feed_get_does_not_write_and_fault_post_does_sync(self):
        self.engine.minutes = 720
        self.engine.set_fault("p01", "disconnected", True)
        self.tick(3)
        full = self.engine.snapshot(full_anomalies=True)
        self.store.sync_registry(full)
        self.assertEqual(self.count("equipment_anomalies"), 0)

        # Reading the feed must not create or change alarm records.
        status, body = self.http("GET", "/api/alarms?status=all")
        self.assertEqual(status, 200)
        self.assertEqual(body["items"], [])
        self.assertEqual(self.count("equipment_anomalies"), 0)

        # A fault mutation syncs the detector state immediately.
        status, _ = self.http(
            "POST", "/api/fault",
            {"device_id": "p01", "fault_id": "disconnected", "active": False})
        self.assertEqual(status, 200)
        self.assertEqual(self.count("equipment_anomalies"), 1)
        status, body = self.http("GET", "/api/alarms?status=active")
        self.assertEqual(status, 200)
        self.assertEqual([i["equipment_id"] for i in body["items"]], ["p01"])


class TestEnergyUnits(BackendTestBase):
    def test_live_series_in_epoch_seconds_is_integrated_in_minutes(self):
        base = 1_700_000_000
        history = [
            {"measured_at": base + 15 * i, "actual_kw": 10.0,
             "measured_day": 1, "measured_time": "12:00"}
            for i in range(241)  # one hour, 15-second cadence
        ]
        detail = {
            "source": "live", "actual": 10.0, "measured_at": {},
            "history": [], "rating": 12.0, "operating_hours": 1.0,
            "energy_today_kwh": None, "persisted": {"history": history},
        }
        block = server.Handler._energy_block(detail)
        calculated = block["calculated"]
        self.assertEqual(calculated["status"], "ok")
        self.assertAlmostEqual(calculated["duration_hours"], 1.0, places=3)
        self.assertAlmostEqual(calculated["energy_kwh"], 10.0, places=3)
        self.assertAlmostEqual(block["baseline"]["duration_hours"], 1.0,
                               places=3)

    def test_live_baseline_window_is_twenty_four_hours(self):
        base = 1_700_000_000
        # 25 hours at 60-second cadence, constant 10 kW.
        history = [
            {"measured_at": base + 60 * i, "actual_kw": 10.0,
             "measured_day": 1, "measured_time": "12:00"}
            for i in range(25 * 60 + 1)
        ]
        detail = {
            "source": "imported", "actual": 10.0, "measured_at": {},
            "history": [], "rating": 12.0, "operating_hours": 25.0,
            "energy_today_kwh": None, "persisted": {"history": history},
        }
        block = server.Handler._energy_block(detail)
        self.assertAlmostEqual(block["calculated"]["duration_hours"], 25.0,
                               places=2)
        self.assertAlmostEqual(block["baseline"]["duration_hours"], 24.0,
                               places=2)
        self.assertAlmostEqual(block["baseline"]["energy_kwh"], 240.0,
                               places=2)


class TestDeviceDetailEvents(BackendTestBase):
    def test_engine_detail_copies_alerts_under_the_lock(self):
        self.engine.minutes = 720
        self.engine.set_fault("p01", "disconnected", True)
        self.tick(3)
        detail = self.engine.device_detail("p01")
        self.assertTrue(detail["alerts"])
        self.assertTrue(all(a["device_id"] == "p01" for a in detail["alerts"]))
        self.assertTrue(all(a["severity"] != "operator"
                            for a in detail["alerts"]))


if __name__ == "__main__":
    unittest.main()
