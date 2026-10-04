import tempfile
import unittest

from intelligence.engine import EnergyIntelligence
from intelligence.metrics import calculate
from intelligence.reports import savings_scenario


def snapshot():
    return {
        "sim": {"day": 1, "time": "12:00"},
        "kpis": {"today": {"solar_kwh": 100, "load_kwh": 120, "import_kwh": 20, "export_kwh": 0}},
        "devices": [
            {"id": "solar", "name": "Solar Array", "kind": "solar",
             "actual": 7.0, "expected": 8.0, "status": "ok", "extra": {}},
            {"id": "inverter", "name": "Inverter", "kind": "inverter",
             "actual": 6.8, "expected": 7.7, "status": "ok", "extra": {}},
            {"id": "hvac", "name": "HVAC", "kind": "hvac",
             "actual": 11.0, "expected": 8.0, "status": "serious", "extra": {}},
            {"id": "lighting", "name": "Lighting", "kind": "lighting",
             "actual": 2.0, "expected": 2.0, "status": "ok", "extra": {}},
        ],
        "anomalies": [{
            "id": 1, "device_id": "hvac", "device_name": "HVAC",
            "severity": "serious", "message": "HVAC consumption above expected",
            "active": True,
        }],
    }


class TestIntelligence(unittest.TestCase):
    def test_waste_and_score(self):
        m = calculate(snapshot())
        self.assertAlmostEqual(m["instantaneous_waste_kw"], 3.0)
        self.assertGreater(m["health_score"], 0)
        self.assertLessEqual(m["health_score"], 100)

    def test_sensor_health_is_separate(self):
        s = snapshot()
        s["devices"][2]["extra"]["sensor_flags"] = ["sensor_dropout"]
        m = calculate(s)
        self.assertLess(m["health_components"]["sensors"], 100)
        self.assertGreater(m["health_components"]["equipment"], 0)

    def test_scenario(self):
        r = savings_scenario(snapshot(), "hvac", 100, 8)
        self.assertEqual(r["daily_savings_kwh"], 24.0)
        self.assertEqual(r["monthly_savings_kwh"], 720.0)

    def test_engine_persists(self):
        with tempfile.TemporaryDirectory() as d:
            ei = EnergyIntelligence(db_path=f"{d}/energy.db")
            try:
                result = ei.analyze(snapshot())
                self.assertIn("recommendations", result)
                self.assertEqual(len(ei.history(1)), 1)
            finally:
                ei.close()


if __name__ == "__main__":
    unittest.main()
