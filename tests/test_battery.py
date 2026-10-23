"""Phase 5a — battery storage unit tests.

The engine is ticked directly (a fresh engine runs unpaused), so these tests
exercise charge/discharge behaviour, state-of-charge limits, the two battery
faults, detector integration and the snapshot/KPI surface without touching
the shared paused simulation.
"""

import unittest

from sim.engine import SimulationEngine


class BatteryStorageTests(unittest.TestCase):
    def setUp(self):
        self.engine = SimulationEngine()
        self.battery = self.engine.devices[6]

    def test_battery_is_registered(self):
        self.assertEqual(self.battery.id, "battery")
        self.assertEqual(self.battery.kind, "battery_storage")
        self.assertEqual(self.battery.rating, 40.0)
        self.assertEqual(self.battery.capacity_kwh, 120.0)

    def _env(self):
        return {"abs_minutes": self.engine.abs_minutes,
                "hour": self.engine.hour}

    def test_charges_on_solar_surplus(self):
        # The campus consumes more than it generates (sufficiency ~52%), so
        # a genuine surplus needs fault-driven load drops. The charge logic
        # itself is deterministic: drive the storage step directly.
        battery = self.engine.devices[6]
        dt_h = 1.0
        flow = battery._flow(20.0, 0.95, True, dt_h)   # 20 kW surplus
        self.assertGreater(flow, 0)
        self.assertLessEqual(flow, battery.charge_rate)
        before = battery.soc_kwh
        battery.step(self._env(), 20.0, dt_h)
        self.assertGreater(battery.soc_kwh, before)
        self.assertAlmostEqual(battery.actual, battery.expected, places=6,
                               msg="healthy storage must not deviate")
        # near-full: charging stops at the 95% cap
        battery.soc_kwh = 120.0 * 0.95 - 0.5
        battery.step(self._env(), 20.0, dt_h)
        self.assertLessEqual(battery.soc_kwh, 120.0 * 0.95 + 0.01)

    def test_discharges_at_night(self):
        engine = self.engine
        engine.speed = 60
        engine.minutes = 120  # 02:00
        # give it charge to work with
        engine.devices[6].soc_kwh = 80.0
        before = engine.devices[6].soc_kwh
        for _ in range(12):
            engine.tick()
        after = engine.devices[6].soc_kwh
        self.assertLess(after, before, "battery should discharge to cover night load")

    def test_state_of_charge_floor_respected(self):
        engine = self.engine
        engine.speed = 60
        engine.minutes = 120
        engine.devices[6].soc_kwh = 12.5  # just above the 10% floor
        for _ in range(60):
            engine.tick()
        self.assertGreaterEqual(engine.devices[6].soc_kwh, 120.0 * 0.10 - 0.01)

    def _drive_battery_with_surplus(self, battery, surplus=20.0, ticks=6):
        """Step the storage against a direct surplus and run the real
        detector so injected battery faults are raised like in the engine."""
        engine = self.engine
        engine.tick()
        for _ in range(ticks):
            battery.step(self._env(), surplus, engine.speed / 60.0)
            engine.detector.update(engine, self._env())

    def test_reduced_capacity_caps_charge_and_flags(self):
        engine = self.engine
        engine.set_fault("battery", "reduced_capacity", True)
        self._drive_battery_with_surplus(engine.devices[6])
        self.assertLessEqual(engine.devices[6].soc_kwh, 120.0 * 0.60 + 0.01)
        self.assertTrue(any(e["device_id"] == "battery" and e["active"]
                            for e in engine.events),
                        "reduced capacity should raise a battery anomaly")

    def test_charge_fault_blocks_charging_and_flags(self):
        engine = self.engine
        engine.devices[6].soc_kwh = 40.0
        engine.set_fault("battery", "charge_fault", True)
        self._drive_battery_with_surplus(engine.devices[6])
        # healthy model wants to charge (expected > 0) while actual stays 0
        self.assertGreater(engine.devices[6].expected, 0)
        self.assertAlmostEqual(engine.devices[6].actual, 0.0, places=2)
        self.assertTrue(any(e["device_id"] == "battery" and e["active"]
                            for e in engine.events))

    def test_healthy_battery_is_never_anomalous(self):
        engine = self.engine
        engine.speed = 60
        for _ in range(120):
            engine.tick()
        self.assertFalse(any(e["device_id"] == "battery" and e["active"]
                             for e in engine.events))

    def test_snapshot_kpis_and_energy(self):
        engine = self.engine
        engine.speed = 60
        engine.minutes = 720
        engine.weather.mode = "clear"
        for _ in range(20):
            engine.tick()
        snap = engine.snapshot()
        k = snap["kpis"]
        self.assertIn("storage_kw", k)
        self.assertIn("soc_pct", k)
        self.assertGreaterEqual(k["soc_pct"], 0)
        self.assertLessEqual(k["soc_pct"], 100)
        self.assertIn("storage_charge_kwh", k["today"])
        self.assertIn("storage_discharge_kwh", k["today"])
        dev = next(d for d in snap["devices"] if d["id"] == "battery")
        self.assertEqual(dev["kind"], "battery_storage")
        self.assertIn("soc_pct", dev["extra"])
        self.assertIn("charged_today_kwh", dev["extra"])
        self.assertIn("discharged_today_kwh", dev["extra"])

    def test_day_rollover_carries_storage_energy(self):
        engine = self.engine
        engine.speed = 60
        engine.minutes = 720
        engine.weather.mode = "clear"
        for _ in range(10):
            engine.tick()
        engine.minutes = 1439
        engine.tick()
        y = engine.snapshot()["kpis"]["yesterday"]
        self.assertIn("storage_charge_kwh", y)
        self.assertGreaterEqual(y["storage_charge_kwh"], 0)


if __name__ == "__main__":
    unittest.main()
