"""Tests for the dataset bridge: Ali's sensor dataset -> ai/anomaly.py + ai/agent.py.

Run with:  python -m unittest tests.test_dataset_bridge -v
"""

from __future__ import annotations

import csv
import unittest
from pathlib import Path

from dataset.adapter import row_to_devices, load_devices
from dataset.sensor_faults import classify_dataset


CSV_PATH = Path(__file__).parent.parent / "dataset" / "sensor_data.csv"


def _read_rows():
    with CSV_PATH.open("r", encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


class TestAdapter(unittest.TestCase):
    """Checks dataset/adapter.py converts CSV rows to device-shaped dicts."""

    def test_row_to_devices_returns_solar_and_inverter(self):
        rows = _read_rows()
        devices = row_to_devices(rows[0])
        self.assertEqual(len(devices), 2)
        self.assertEqual(devices[0]["id"], "solar")
        self.assertEqual(devices[0]["kind"], "solar")
        self.assertEqual(devices[1]["id"], "inverter")
        self.assertEqual(devices[1]["kind"], "inverter")

    def test_device_dict_has_required_keys(self):
        """ai/agent.py's diagnose() reads these exact keys."""
        rows = _read_rows()
        for dev in row_to_devices(rows[0]):
            for key in ("id", "name", "kind", "rating", "actual", "expected", "rel", "extra"):
                self.assertIn(key, dev, f"missing key '{key}' in {dev['id']}")

    def test_inverter_expected_is_about_97_percent_of_solar(self):
        """Adapter rounds to 1 decimal, so allow 0.1 W tolerance."""
        rows = _read_rows()
        solar, inverter = row_to_devices(rows[0])
        self.assertAlmostEqual(
            inverter["expected"], solar["expected"] * 0.97, delta=0.2
        )

    def test_load_devices_yields_two_per_row(self):
        count = sum(1 for _ in load_devices())
        rows = _read_rows()
        self.assertEqual(count, len(rows) * 2)

    def test_sensor_flags_present_in_extra(self):
        rows = _read_rows()
        devs = row_to_devices(rows[0])
        self.assertIn("sensor_flags", devs[0]["extra"])
        self.assertIsInstance(devs[0]["extra"]["sensor_flags"], list)


class TestSensorFaults(unittest.TestCase):
    """Checks dataset/sensor_faults.py names the injected fault types.

    Note: some rows are ambiguous by design (e.g. the first tick of a stuck
    sensor has healthy voltage still near 420 V, so it looks clean). We test
    that at least ONE row of each fault type is correctly flagged, not all.
    """

    def setUp(self):
        self.rows = _read_rows()
        self.predictions = classify_dataset(self.rows)

    def _rows_with_truth(self, truth: str):
        """Yield (row, flags) for every row labeled `truth`."""
        for row, flags in zip(self.rows, self.predictions):
            if (row.get("fault_type") or "").strip() == truth:
                yield row, flags

    def _assert_any_flagged(self, truth: str, expected_flag: str):
        matches = list(self._rows_with_truth(truth))
        self.assertTrue(matches, f"no rows labeled '{truth}' in dataset")
        hits = [f for _, f in matches if expected_flag in f]
        self.assertTrue(
            hits,
            f"no row labeled '{truth}' produced flag '{expected_flag}' "
            f"(checked {len(matches)} rows)"
        )

    def test_normal_row_has_no_flags(self):
        rows = list(self._rows_with_truth("normal"))
        self.assertTrue(rows)
        row, flags = rows[0]
        self.assertEqual(flags, [], f"expected no flags, got {flags}")

    def test_voltage_bias_rows_are_flagged(self):
        self._assert_any_flagged("voltage_bias", "voltage_bias")

    def test_sensor_dropout_rows_are_flagged(self):
        self._assert_any_flagged("sensor_dropout", "sensor_dropout")

    def test_stuck_sensor_rows_are_flagged(self):
        self._assert_any_flagged("stuck_sensor", "stuck_sensor")

    def test_panel_overheating_rows_are_flagged(self):
        self._assert_any_flagged("panel_overheating", "panel_overheating")

    def test_inverter_overheating_rows_are_flagged(self):
        self._assert_any_flagged("inverter_overheating", "inverter_overheating")

    def test_grid_voltage_anomaly_rows_are_flagged(self):
        self._assert_any_flagged("grid_voltage_anomaly", "grid_voltage_anomaly")

    def test_power_loss_rows_are_flagged(self):
        self._assert_any_flagged("power_loss", "power_loss")


class TestOverallAccuracy(unittest.TestCase):
    """Regression guard: overall accuracy must not drop below 90%."""

    def test_overall_accuracy_above_90_percent(self):
        rows = _read_rows()
        preds = classify_dataset(rows)

        priority = [
            "sensor_dropout", "stuck_sensor", "voltage_bias", "voltage_drift",
            "sensor_noise", "inverter_overheating", "panel_overheating",
            "grid_voltage_anomaly", "power_loss",
        ]

        correct = 0
        for row, flags in zip(rows, preds):
            truth = (row.get("fault_type") or "normal").strip()
            pred = "normal"
            for name in priority:
                if name in flags:
                    pred = name
                    break
            if pred == truth:
                correct += 1

        accuracy = correct / len(rows)
        self.assertGreaterEqual(
            accuracy, 0.90,
            f"overall accuracy dropped to {accuracy:.1%} (expected >= 90%)"
        )


if __name__ == "__main__":
    unittest.main()