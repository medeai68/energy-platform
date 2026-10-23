"""Individual solar panel simulation: identity, fault isolation, recovery.

Covers the panel-level digital-twin acceptance criteria:
  - every panel has a stable unique id and row/column position
  - a fault injected on one panel changes only that panel
  - panel faults feed the aggregate array output and the dashboard KPIs
  - clearing a fault restores the panel and closes its anomaly event
"""

import unittest

from sim.engine import SimulationEngine
from sim.faults import faults_for


class TestPanels(unittest.TestCase):
    def setUp(self):
        self.eng = SimulationEngine()

    def tick_daylight(self, n):
        """Advance n ticks starting from day 1 06:00 (speed 60 = 1 h/tick)."""
        for _ in range(n):
            self.eng.tick()

    def panel(self, pid):
        return next(p for p in self.eng.panels if p.id == pid)

    def active_anomalies(self, device_id=None):
        return [e for e in self.eng.events
                if e["active"] and e["severity"] != "operator"
                and (device_id is None or e["device_id"] == device_id)]

    def test_panel_identity_and_layout(self):
        self.assertEqual(len(self.eng.panels), 48)
        self.assertEqual(self.panel("p01").row, 1)
        self.assertEqual(self.panel("p01").col, 1)
        self.assertEqual(self.panel("p12").row, 1)
        self.assertEqual(self.panel("p12").col, 12)
        self.assertEqual(self.panel("p13").row, 2)
        self.assertEqual(self.panel("p13").col, 1)
        self.assertEqual(self.panel("p48").row, 4)
        self.assertEqual(self.panel("p48").col, 12)
        # ids are unique and stable across resets
        ids = [p.id for p in self.eng.panels]
        self.assertEqual(len(set(ids)), 48)
        self.eng.reset()
        self.assertEqual([p.id for p in self.eng.panels], ids)
        # panel ratings sum to the 50 kWp array rating
        self.assertAlmostEqual(sum(p.rating for p in self.eng.panels), 50.0)

    def test_healthy_panels_sum_to_array(self):
        self.tick_daylight(6)  # 06:00 -> 12:00, full daylight
        solar = next(d for d in self.eng.devices if d.id == "solar")
        self.assertGreater(solar.expected, 5.0)
        self.assertAlmostEqual(solar.actual, sum(p.actual for p in self.eng.panels),
                               delta=0.01)
        # healthy panels keep their own readings but stay inside the noise band
        for p in self.eng.panels:
            self.assertGreaterEqual(p.actual, 0.0)
            rel = (p.actual - p.expected) / max(p.expected, p.rel_floor)
            self.assertLess(abs(rel), 0.10)
        self.assertEqual(self.eng.detector.device_status("p01"), "ok")

    def test_fault_isolation_single_panel(self):
        self.tick_daylight(6)  # midday
        solar = next(d for d in self.eng.devices if d.id == "solar")
        healthy_total = solar.actual
        self.assertTrue(self.eng.set_fault("p01", "reduced_output", True))
        # one tick is not enough to raise; two sustained ticks are
        self.tick_daylight(2)
        p01 = self.panel("p01")
        self.assertNotEqual(self.eng.detector.device_status("p01"), "ok")
        self.assertLess(p01.actual, p01.expected)
        # every other panel keeps its own state
        for p in self.eng.panels:
            if p.id == "p01":
                continue
            self.assertEqual(self.eng.detector.device_status(p.id), "ok")
            self.assertAlmostEqual(p.actual, p.expected,
                                   delta=0.1 * max(p.expected, p.rel_floor))
        # the aggregate reflects the single-panel loss
        solar = next(d for d in self.eng.devices if d.id == "solar")
        self.assertLess(solar.actual, healthy_total)
        self.assertAlmostEqual(solar.actual, sum(p.actual for p in self.eng.panels),
                               delta=0.01)
        # exactly one anomaly, and it names P-01
        anomalies = self.active_anomalies()
        self.assertEqual(len(anomalies), 1)
        self.assertEqual(anomalies[0]["device_id"], "p01")
        self.assertEqual(anomalies[0]["device_name"], "Panel P-01")

    def test_disconnected_panel_goes_offline(self):
        self.tick_daylight(6)
        self.assertTrue(self.eng.set_fault("p02", "disconnected", True))
        self.tick_daylight(3)
        p02 = self.panel("p02")
        self.assertAlmostEqual(p02.actual, 0.0, delta=0.06)
        self.assertEqual(self.eng.detector.device_status("p02"), "critical")
        self.assertEqual(self.eng.detector.device_status("p01"), "ok")

    def test_clear_fault_recovers_panel(self):
        self.tick_daylight(6)
        self.eng.set_fault("p01", "reduced_output", True)
        self.tick_daylight(3)
        self.assertNotEqual(self.eng.detector.device_status("p01"), "ok")
        self.assertTrue(self.eng.set_fault("p01", "reduced_output", False))
        self.tick_daylight(3)  # recovery needs 3 consecutive in-bounds ticks
        self.assertEqual(self.eng.detector.device_status("p01"), "ok")
        self.assertEqual(self.active_anomalies("p01"), [])
        # output restored to the healthy band
        p01 = self.panel("p01")
        self.assertAlmostEqual(p01.actual, p01.expected,
                               delta=0.1 * max(p01.expected, p01.rel_floor))

    def test_snapshot_contains_panels(self):
        self.tick_daylight(6)
        snap = self.eng.snapshot()
        self.assertEqual(len(snap["panels"]), 48)
        p = snap["panels"][0]
        for key in ("id", "name", "kind", "row", "col", "rating",
                    "actual", "expected", "rel", "status", "faults", "extra"):
            self.assertIn(key, p)
        self.assertEqual(p["kind"], "panel")
        self.assertIn("performance", p["extra"])

    def test_panel_detail_and_fault_catalog(self):
        detail = self.eng.device_detail("p07")
        self.assertIsNotNone(detail)
        self.assertEqual(detail["panel"]["row"], 1)
        self.assertEqual(detail["panel"]["col"], 7)
        self.assertEqual(detail["panel"]["cols"], 12)
        catalog_ids = {f["id"] for f in faults_for("panel")}
        self.assertEqual(catalog_ids, {"reduced_output", "overheating", "disconnected",
                                    "sensor_drift", "sensor_stuck"})
        self.assertEqual({f["id"] for f in detail["faults"]}, catalog_ids)

    def test_reset_clears_panel_faults(self):
        self.tick_daylight(6)
        self.eng.set_fault("p01", "disconnected", True)
        self.tick_daylight(3)
        self.eng.reset()
        self.assertEqual(self.eng.detector.device_status("p01"), "ok")
        self.assertEqual(self.panel("p01").faults, set())
        self.assertEqual(self.active_anomalies("p01"), [])


if __name__ == "__main__":
    unittest.main()
