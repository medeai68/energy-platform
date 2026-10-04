import unittest

from dataset.adapter import row_to_devices
from dataset.sensor_faults import classify_row
from ai.agent import diagnose


def base_row(**overrides):
    row = {
        "normal_voltage": "420",
        "faulty_voltage": "420",
        "current": "16",
        "normal_power": "6400",
        "measured_power": "6400",
        "panel_temperature": "45",
        "inverter_temperature": "50",
        "grid_voltage": "230",
    }
    row.update(overrides)
    return row


class TestFixedBridge(unittest.TestCase):
    def test_units_are_kw(self):
        solar, inverter = row_to_devices(base_row())
        self.assertAlmostEqual(solar["expected"], 6.4)
        self.assertAlmostEqual(solar["actual"], 6.4)
        self.assertAlmostEqual(inverter["expected"], 6.208)

    def test_dropout_is_not_masked(self):
        row = base_row(faulty_voltage="", measured_power="")
        solar, inverter = row_to_devices(row)
        self.assertIsNone(solar["actual"])
        self.assertIsNone(inverter["actual"])
        self.assertIn("sensor_dropout", solar["extra"]["sensor_flags"])

    def test_adapter_uses_classifier(self):
        row = base_row(normal_voltage="420", faulty_voltage="450")
        flags = classify_row(row)
        solar, _ = row_to_devices(row)
        self.assertEqual(flags, solar["extra"]["sensor_flags"])

    def test_sensor_branch_precedes_noise_return(self):
        row = base_row(normal_voltage="420", faulty_voltage="420", measured_power="6400")
        row["faulty_voltage"] = ""
        solar, _ = row_to_devices(row)
        diagnosis = diagnose(
            solar,
            {"severity": "warning", "day": 1, "time": "12:00"},
            solar["rel"],
            use_claude=False,
        )
        self.assertEqual(diagnosis["primary_fault"], "sensor_dropout")

    def test_power_loss_reaches_agent(self):
        row = base_row(measured_power="4000", current="10")
        solar, _ = row_to_devices(row)
        self.assertIn("power_loss", solar["extra"]["sensor_flags"])
        diagnosis = diagnose(solar, {"severity": "serious"}, solar["rel"], use_claude=False)
        self.assertEqual(diagnosis["primary_fault"], "power_loss")


if __name__ == "__main__":
    unittest.main()
