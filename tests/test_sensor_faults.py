"""Phase 5b — sensor-fault layer unit tests.

Sensor-layer faults corrupt the *measurement* only: the platform records the
distorted reading, aggregates stay honest sums, the detector flags the
deviation like any other, and the AI agent names it as a sensor fault (the
equipment may be healthy).
"""

import unittest

from ai.agent import diagnose
from sim.engine import SimulationEngine
from sim.faults import faults_for


class SensorFaultTests(unittest.TestCase):
    def setUp(self):
        self.engine = SimulationEngine()
        self.engine.speed = 60

    def test_catalog_exposes_sensor_layer_for_every_kind(self):
        for kind in ("room_light", "fcu", "solar", "battery_storage"):
            ids = {f["id"]: f for f in faults_for(kind)}
            self.assertIn("sensor_drift", ids)
            self.assertIn("sensor_stuck", ids)
            self.assertEqual(ids["sensor_drift"]["layer"], "sensor")

    def test_drift_distorts_measurement_and_flags(self):
        engine = self.engine
        engine.minutes = 720
        engine.set_fault("lt-b1f1r1", "sensor_drift", True)
        engine.tick()
        engine.tick()
        leaf = next(d for d in engine.snapshot()["equipment"]
                    if d["id"] == "lt-b1f1r1")
        self.assertAlmostEqual(leaf["actual"], leaf["expected"] * 1.35,
                               places=1)
        self.assertTrue(any(e["device_id"] == "lt-b1f1r1" and e["active"]
                            for e in engine.events),
                        "drift should raise an anomaly after 2 ticks")

    def test_stuck_freezes_measurement(self):
        engine = self.engine
        engine.minutes = 720
        engine.tick()
        engine.tick()
        snap1 = next(d for d in engine.snapshot()["equipment"]
                     if d["id"] == "lt-b1f1r1")
        engine.set_fault("lt-b1f1r1", "sensor_stuck", True)
        engine.minutes = 900  # different hour -> expected changes
        engine.tick()
        engine.tick()
        snap2 = next(d for d in engine.snapshot()["equipment"]
                     if d["id"] == "lt-b1f1r1")
        self.assertAlmostEqual(snap2["actual"], snap1["actual"], places=1,
                               msg="stuck sensor must freeze the reading")
        self.assertNotAlmostEqual(snap2["expected"], snap1["expected"],
                                  places=1)

    def test_clearing_stuck_resumes_measurement(self):
        engine = self.engine
        engine.minutes = 720
        engine.set_fault("lt-b1f1r1", "sensor_stuck", True)
        engine.tick()
        engine.tick()
        engine.set_fault("lt-b1f1r1", "sensor_stuck", False)
        engine.tick()
        leaf = next(d for d in engine.snapshot()["equipment"]
                    if d["id"] == "lt-b1f1r1")
        self.assertNotAlmostEqual(leaf["actual"], leaf["expected"] * 1.35,
                                  places=1)

    def test_aggregates_stay_honest_sums(self):
        engine = self.engine
        engine.minutes = 720
        engine.set_fault("lt-b1f1r1", "sensor_drift", True)
        engine.tick()
        snap = engine.snapshot()
        lighting = next(d for d in snap["devices"] if d["id"] == "lighting")
        leaves = [d for d in snap["equipment"] if d["kind"] == "room_light"]
        self.assertAlmostEqual(lighting["actual"], sum(d["actual"] for d in leaves), places=1)

    def test_agent_names_sensor_faults(self):
        engine = self.engine
        engine.minutes = 720
        engine.set_fault("lt-b1f1r1", "sensor_drift", True)
        engine.tick()
        engine.tick()
        snap = engine.snapshot()
        leaf = next(d for d in snap["equipment"]
                    if d["id"] == "lt-b1f1r1")
        event = next(e for e in snap["events"]
                     if e["device_id"] == "lt-b1f1r1" and e["active"])
        diagnosis = diagnose(leaf, event, leaf["rel"], use_claude=False)
        self.assertEqual(diagnosis["primary_fault"], "sensor_drift")
        self.assertIn("sensor_drift", diagnosis["detected_faults"])
        self.assertIn("may be healthy", diagnosis["causes"][0]["cause"].lower()
                      or diagnosis["summary"].lower())


if __name__ == "__main__":
    unittest.main()
