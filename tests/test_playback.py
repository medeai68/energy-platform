"""Historical energy playback (Step 9, feature D).

Acceptance criteria covered:
  - power history is integrated into fixed time buckets for a whole day
  - intervals crossing bucket boundaries are split correctly
  - rooms, floors and buildings aggregate unique devices only (no double
    counting); roof PV is not part of consumption spaces
  - buckets without coverage stay None (empty state, never a fake zero)
  - the payload is explicitly calculated from simulated history, never
    presented as metered consumption
"""

import math
import unittest

from equipment.playback import (
    MAX_BUCKET_MINUTES, MIN_BUCKET_MINUTES, aggregate_series, bucket_energy,
    build_playback, space_inventory, validate_bucket_minutes, validate_day,
)


def make_snapshot():
    return {
        "sim": {"day": 1, "minutes": 360},
        "buildings": [{
            "id": "b1", "name": "Tower A", "area": 200,
            "equipment": [{"id": "e1"}],
            "floors": [{
                "id": "f1", "name": "Floor 1", "area": 200,
                "fcu": {"id": "fc"},
                "rooms": [
                    {"id": "r1", "name": "Room 1", "area": 100,
                     "devices": [{"id": "d1"}]},
                    {"id": "r2", "name": "Room 2", "area": 100,
                     "devices": [{"id": "d2"}]},
                ],
            }],
        }],
    }


def make_series():
    return {
        "d1": [(0, 1.0), (60, 1.0), (120, 1.0)],
        "d2": [(0, 2.0), (60, 2.0), (120, 2.0)],
        "fc": [(0, 1.0), (60, 1.0), (120, 1.0)],
        "e1": [(0, 0.5), (60, 0.5), (120, 0.5)],
        "pv": [(0, 9.0), (60, 9.0), (120, 9.0)],
    }


class TestPlaybackValidation(unittest.TestCase):
    def test_bucket_bounds(self):
        self.assertEqual(validate_bucket_minutes(60), 60.0)
        self.assertEqual(validate_bucket_minutes(MIN_BUCKET_MINUTES),
                         MIN_BUCKET_MINUTES)
        for bad in (0, 4.9, 1441, "x", float("nan"), True):
            with self.assertRaises(ValueError):
                validate_bucket_minutes(bad)

    def test_day_validation(self):
        self.assertEqual(validate_day(2), 2)
        self.assertEqual(validate_day("3"), 3)
        self.assertEqual(validate_day(2.0), 2)
        for bad in (0, -1, 2.5, "2.5", "x", True):
            with self.assertRaises(ValueError):
                validate_day(bad)


class TestAggregation(unittest.TestCase):
    def test_duplicate_timestamps_collapse_last_write_wins(self):
        series = {
            "a": [(0, 1.0), (0, 3.0), (60, 1.0)],
            "b": [(0, 2.0), (60, 2.0)],
        }
        merged = aggregate_series(series, ["a", "b"])
        self.assertEqual([t for t, _ in merged], [0.0, 60.0])
        self.assertAlmostEqual(dict(merged)[0.0], 5.0)
        self.assertAlmostEqual(dict(merged)[60.0], 3.0)

    def test_negative_and_invalid_power_is_ignored(self):
        merged = aggregate_series(
            {"a": [(0, -1.0), (30, float("nan")), (60, 2.0)]}, ["a"])
        self.assertEqual(merged, [(60.0, 2.0)])

    def test_space_inventory_has_unique_membership(self):
        spaces = {s["id"]: s for s in space_inventory(make_snapshot())}
        self.assertEqual(spaces["r1"]["device_ids"], ["d1"])
        self.assertEqual(spaces["r2"]["device_ids"], ["d2"])
        self.assertEqual(spaces["f1"]["device_ids"], ["d1", "d2", "fc"])
        self.assertEqual(spaces["b1"]["device_ids"], ["d1", "d2", "e1", "fc"])
        self.assertEqual(spaces["r1"]["kind"], "room")
        self.assertEqual(spaces["f1"]["parent_id"], "b1")
        self.assertEqual(spaces["b1"]["area"], 200.0)


class TestBucketEnergy(unittest.TestCase):
    def test_constant_power_buckets(self):
        result = bucket_energy([(0, 2.0), (60, 2.0), (120, 2.0)], 60, 1)
        self.assertEqual(len(result["buckets"]), 24)
        self.assertEqual(result["buckets"][0]["time"], "00:00")
        self.assertAlmostEqual(result["buckets"][0]["energy_kwh"], 2.0)
        self.assertAlmostEqual(result["buckets"][1]["energy_kwh"], 2.0)
        self.assertAlmostEqual(result["buckets"][0]["mean_kw"], 2.0)
        self.assertAlmostEqual(result["covered_minutes"], 120.0)
        self.assertAlmostEqual(result["total_energy_kwh"], 4.0)
        self.assertIsNone(result["buckets"][3]["energy_kwh"])
        self.assertEqual(result["buckets"][3]["coverage"], 0.0)

    def test_interval_crossing_a_bucket_boundary_is_split(self):
        result = bucket_energy([(30, 2.0), (90, 2.0)], 60, 1)
        self.assertAlmostEqual(result["buckets"][0]["energy_kwh"], 1.0)
        self.assertAlmostEqual(result["buckets"][1]["energy_kwh"], 1.0)
        self.assertAlmostEqual(result["buckets"][0]["covered_minutes"], 30.0)
        self.assertAlmostEqual(result["buckets"][1]["covered_minutes"], 30.0)
        self.assertAlmostEqual(result["total_energy_kwh"], 2.0)

    def test_variable_power_is_trapezoidal(self):
        # 1 kW -> 3 kW over one hour = 2 kWh
        result = bucket_energy([(0, 1.0), (60, 3.0)], 60, 1)
        self.assertAlmostEqual(result["buckets"][0]["energy_kwh"], 2.0)

    def test_selected_day_only(self):
        result = bucket_energy([(0, 2.0), (60, 2.0)], 60, 2)
        self.assertTrue(all(b["energy_kwh"] is None for b in result["buckets"]))
        self.assertEqual(result["covered_minutes"], 0.0)

    def test_gap_is_skipped(self):
        result = bucket_energy([(0, 2.0), (600, 2.0)], 60, 1,
                               max_gap_minutes=120)
        self.assertEqual(result["skipped_intervals"], 1)
        self.assertEqual(result["total_energy_kwh"], 0.0)

    def test_bucket_size_must_divide_the_day_cleanly_or_ceils(self):
        result = bucket_energy([(0, 2.0), (60, 2.0)], 45, 1)
        self.assertEqual(len(result["buckets"]), 32)  # ceil(1440 / 45)
        self.assertEqual(result["buckets"][-1]["time"], "23:15")
        self.assertAlmostEqual(result["covered_minutes"], 60.0)


class TestBuildPlayback(unittest.TestCase):
    def test_hierarchy_energy_and_intensities(self):
        payload = build_playback(make_snapshot(), make_series(), 60, 1)
        spaces = {s["id"]: s for s in payload["spaces"]}
        self.assertEqual(spaces["r1"]["series"][0]["energy_kwh"], 1.0)
        self.assertEqual(spaces["r2"]["series"][0]["energy_kwh"], 2.0)
        self.assertEqual(spaces["f1"]["series"][0]["energy_kwh"], 4.0)
        self.assertEqual(spaces["b1"]["series"][0]["energy_kwh"], 4.5)
        self.assertAlmostEqual(
            spaces["r1"]["series"][0]["intensity_kwh_m2"], 0.01)
        self.assertAlmostEqual(
            spaces["b1"]["series"][0]["intensity_kwh_m2"], 0.0225)
        # roof PV is not in any consumption space
        self.assertNotIn("pv", spaces["b1"]["device_ids"])
        self.assertAlmostEqual(payload["max_intensity_kwh_m2"], 0.0225)
        self.assertAlmostEqual(payload["max_energy_kwh"], 4.5)
        self.assertAlmostEqual(payload["covered_minutes"], 120.0)

    def test_timeline_and_empty_buckets(self):
        payload = build_playback(make_snapshot(), make_series(), 60, 1)
        self.assertEqual(payload["bucket_count"], 24)
        self.assertEqual(payload["day"], 1)
        self.assertEqual(payload["timeline"][0]["time"], "00:00")
        self.assertTrue(payload["timeline"][0]["has_data"])
        self.assertFalse(payload["timeline"][5]["has_data"])
        self.assertEqual(payload["timeline"][5]["max_energy_kwh"], 0.0)
        self.assertIsNone(payload["spaces"][0]["series"][5]["energy_kwh"])
        self.assertEqual(payload["spaces"][0]["series"][5]["coverage"], 0.0)

    def test_payload_is_calculated_not_metered(self):
        payload = build_playback(make_snapshot(), make_series(), 60, 1)
        self.assertEqual(payload["basis"], "calculated")
        self.assertEqual(payload["power_source"], "simulated_history")
        self.assertIn("not metered", payload["note"])
        self.assertIn("trapezoidal", payload["note"])
        for space in payload["spaces"]:
            for entry in space["series"]:
                value = entry["energy_kwh"]
                self.assertTrue(value is None or math.isfinite(value))

    def test_no_history_returns_none_values_not_zeros(self):
        payload = build_playback(make_snapshot(), {}, 60, 1)
        for space in payload["spaces"]:
            self.assertTrue(all(e["energy_kwh"] is None
                                for e in space["series"]))
        self.assertEqual(payload["max_intensity_kwh_m2"], 0.0)
        self.assertEqual(payload["covered_minutes"], 0.0)
        self.assertFalse(any(t["has_data"] for t in payload["timeline"]))

    def test_day_defaults_to_snapshot_day(self):
        payload = build_playback(make_snapshot(), make_series(), 60)
        self.assertEqual(payload["day"], 1)


if __name__ == "__main__":
    unittest.main()
