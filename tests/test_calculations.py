"""Documented energy calculations (Step 7).

Acceptance criteria covered:
  - unit-consistent constant-power formula: E(kWh) = P(kW) x t(h)
  - variable power integrated from measured samples over time
  - method selection is documented and reported with every result
  - insufficient data / unsupported gaps produce no number (empty state)
  - scenario estimates from configured rating + operating hours
  - calculated results always carry basis="calculated", never "measured"
"""

import math
import unittest

from equipment.calculations import (
    CONSTANT_POWER_REL_RANGE, calculate_energy, compare_baseline_scenario,
    constant_power_energy, scheduled_minutes_between, scenario_energy,
    validate_scenario, validate_scenario_config,
)


class TestConstantPower(unittest.TestCase):
    def test_documented_formula_units(self):
        # 5 kW for 8 h = 40 kWh
        self.assertEqual(constant_power_energy(5.0, 8.0), 40.0)
        # 1.5 kW for 0.5 h = 0.75 kWh
        self.assertAlmostEqual(constant_power_energy(1.5, 0.5), 0.75)

    def test_invalid_inputs_are_rejected(self):
        for power, hours in [(-1, 2), (1, -2), (float("nan"), 2),
                             (1, float("inf")), ("x", 2)]:
            with self.assertRaises(ValueError):
                constant_power_energy(power, hours)


class TestCalculateEnergy(unittest.TestCase):
    def test_constant_series_uses_power_times_time(self):
        # 2 kW over 120 sim minutes = 2 h -> 4 kWh
        result = calculate_energy([(0, 2.0), (60, 2.0), (120, 2.0)])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["method"], "constant_power")
        self.assertEqual(result["formula"], "E = P × t")
        self.assertAlmostEqual(result["energy_kwh"], 4.0)
        self.assertAlmostEqual(result["duration_hours"], 2.0)
        self.assertEqual(result["used_samples"], 3)
        self.assertAlmostEqual(result["relative_range"], 0.0)

    def test_variable_power_uses_trapezoidal_integration(self):
        # 1 kW -> 3 kW -> 1 kW over two 30-minute intervals:
        # (1+3)/2 * 0.5 h + (3+1)/2 * 0.5 h = 2 kWh
        result = calculate_energy([(0, 1.0), (30, 3.0), (60, 1.0)])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["method"], "variable_integration")
        self.assertIn("Δt", result["formula"])
        self.assertAlmostEqual(result["energy_kwh"], 2.0)
        self.assertAlmostEqual(result["duration_hours"], 1.0)
        self.assertGreater(result["relative_range"],
                           CONSTANT_POWER_REL_RANGE)

    def test_method_threshold_is_reported(self):
        result = calculate_energy([(0, 2.0), (60, 2.1)])
        self.assertEqual(
            result["thresholds"]["constant_power_max_relative_range"],
            CONSTANT_POWER_REL_RANGE)

    def test_insufficient_samples_never_invent_a_number(self):
        result = calculate_energy([(0, 2.0)])
        self.assertEqual(result["status"], "insufficient_data")
        self.assertIsNone(result["energy_kwh"])
        self.assertIsNotNone(result["reason"])
        self.assertEqual(calculate_energy([])["energy_kwh"], None)

    def test_long_gap_is_skipped_when_data_does_not_support_it(self):
        # 0..60 is usable, 60..600 is a 9 h gap -> skipped
        result = calculate_energy(
            [(0, 2.0), (60, 2.0), (600, 2.0)], max_gap_minutes=120)
        self.assertEqual(result["status"], "ok")
        self.assertAlmostEqual(result["energy_kwh"], 2.0)
        self.assertAlmostEqual(result["duration_hours"], 1.0)
        self.assertEqual(result["skipped_intervals"], 1)
        self.assertEqual(result["used_samples"], 2)

    def test_all_gaps_unsupported_returns_empty_state(self):
        result = calculate_energy([(0, 2.0), (600, 2.0)], max_gap_minutes=120)
        self.assertEqual(result["status"], "no_continuous_window")
        self.assertIsNone(result["energy_kwh"])

    def test_duplicate_timestamps_collapse_to_last_value(self):
        # the canonical measurement rule: same timestamp -> last write wins
        result = calculate_energy([(0, 1.0), (0, 4.0), (60, 4.0)])
        self.assertEqual(result["samples"], 2)
        self.assertAlmostEqual(result["energy_kwh"], 4.0)
        self.assertEqual(result["method"], "constant_power")

    def test_results_are_always_calculated_never_measured(self):
        for samples in ([(0, 1.0), (60, 1.0)], [(0, 1.0), (60, 3.0)],
                        [(0, 1.0)]):
            result = calculate_energy(samples)
            self.assertEqual(result["basis"], "calculated")
            self.assertIn("not a metered reading", result["note"])

    def test_non_finite_and_invalid_samples_are_ignored(self):
        result = calculate_energy(
            [(0, 2.0), (None, 5.0), (30, float("nan")), (60, 2.0)])
        self.assertEqual(result["samples"], 2)
        self.assertAlmostEqual(result["energy_kwh"], 2.0)


class TestScenario(unittest.TestCase):
    def test_constant_power_scenario_estimate(self):
        result = scenario_energy(6.0, 8.0)
        self.assertAlmostEqual(result["daily_energy_kwh"], 48.0)
        self.assertAlmostEqual(result["monthly_energy_kwh"], 1440.0)
        self.assertEqual(result["basis"], "calculated")
        self.assertEqual(result["method"], "constant_power")
        self.assertEqual(result["formula"], "E = P × t")
        self.assertIn("not measured", result["note"])

    def test_scenario_bounds_are_enforced(self):
        for rated, hours in [(-1, 8), (6, -1), (6, 24.5),
                             (float("nan"), 8), (6, "8x")]:
            with self.assertRaises(ValueError):
                scenario_energy(rated, hours)
        self.assertEqual(validate_scenario(0, 0), (0.0, 0.0))
        self.assertEqual(validate_scenario("6", "8"), (6.0, 8.0))

    def test_zero_hours_gives_zero_energy(self):
        result = scenario_energy(6.0, 0)
        self.assertEqual(result["daily_energy_kwh"], 0.0)
        self.assertTrue(math.isfinite(result["monthly_energy_kwh"]))

    def test_load_factor_scales_energy(self):
        result = scenario_energy(10.0, 8.0, load_factor=0.5)
        self.assertAlmostEqual(result["effective_power_kw"], 5.0)
        self.assertAlmostEqual(result["daily_energy_kwh"], 40.0)
        self.assertAlmostEqual(result["monthly_energy_kwh"], 1200.0)
        self.assertEqual(result["formula"], "E = P × t × LF")
        self.assertEqual(result["load_factor"], 0.5)
        self.assertEqual(result["basis"], "calculated")
        self.assertIn("not measured", result["note"])

    def test_schedule_is_described_but_does_not_change_daily_total(self):
        default = scenario_energy(6.0, 8.0)
        scheduled = scenario_energy(6.0, 8.0, schedule_start=9.0)
        self.assertAlmostEqual(default["daily_energy_kwh"],
                               scheduled["daily_energy_kwh"])
        self.assertEqual(scheduled["schedule_label"], "09:00–17:00")
        self.assertAlmostEqual(scheduled["schedule_start"], 9.0)
        self.assertAlmostEqual(scheduled["schedule_end"], 17.0)

    def test_full_scenario_config_validation(self):
        config = validate_scenario_config(6.0, 8.0, 0.5, 9.0)
        self.assertAlmostEqual(config["rated_kw"], 6.0)
        self.assertAlmostEqual(config["load_factor"], 0.5)
        self.assertAlmostEqual(config["schedule_start"], 9.0)
        for args in ((6.0, 8.0, 1.1, 0.0), (6.0, 8.0, -0.1, 0.0),
                     (6.0, 8.0, 1.0, 17.0), (6.0, 8.0, 1.0, -1.0)):
            with self.assertRaises(ValueError):
                validate_scenario_config(*args)


class TestBaselineComparison(unittest.TestCase):
    def test_same_window_comparison(self):
        # baseline: 10 kWh over 8 h (00:00-08:00)
        result = compare_baseline_scenario(10.0, 0.0, 480.0, 2.0, 8.0)
        self.assertEqual(result["basis"], "calculated_comparison")
        self.assertAlmostEqual(result["window"]["hours"], 8.0)
        self.assertAlmostEqual(result["window"]["scheduled_hours"], 8.0)
        self.assertAlmostEqual(result["window"]["scenario_energy_kwh"], 16.0)
        self.assertAlmostEqual(result["window"]["delta_kwh"], 6.0)
        self.assertAlmostEqual(result["window"]["delta_percent"], 60.0)
        self.assertEqual(result["window"]["direction"], "higher")
        self.assertAlmostEqual(result["window"]["savings_kwh"], 0.0)
        self.assertIn("not metered", result["note"])

    def test_schedule_outside_baseline_window_saves_energy(self):
        # baseline 00:00-08:00; scenario runs 09:00-17:00 -> no overlap
        result = compare_baseline_scenario(
            10.0, 0.0, 480.0, 2.0, 8.0, schedule_start=9.0)
        self.assertAlmostEqual(result["window"]["scheduled_hours"], 0.0)
        self.assertAlmostEqual(result["window"]["scenario_energy_kwh"], 0.0)
        self.assertAlmostEqual(result["window"]["savings_kwh"], 10.0)
        self.assertEqual(result["window"]["direction"], "lower")

    def test_load_factor_reduces_scenario(self):
        result = compare_baseline_scenario(
            10.0, 0.0, 480.0, 2.0, 8.0, load_factor=0.5)
        self.assertAlmostEqual(result["window"]["scenario_energy_kwh"], 8.0)
        self.assertAlmostEqual(result["window"]["savings_kwh"], 2.0)
        self.assertEqual(result["scenario"]["formula"], "E = P × t × LF")

    def test_scenario_never_exceeds_baseline_covered_duration(self):
        # window span is 8 h but only 1 h is covered by measurements
        result = compare_baseline_scenario(
            2.0, 0.0, 480.0, 2.0, 8.0, covered_hours=1.0)
        self.assertAlmostEqual(result["window"]["hours"], 8.0)
        self.assertAlmostEqual(result["window"]["covered_hours"], 1.0)
        self.assertAlmostEqual(result["window"]["scheduled_hours"], 1.0)
        self.assertAlmostEqual(result["window"]["scenario_energy_kwh"], 2.0)
        self.assertEqual(result["window"]["direction"], "equal")

    def test_comparison_validation(self):
        for args in ((-1.0, 0, 60, 2.0, 1.0),
                     (1.0, 60, 0, 2.0, 1.0),
                     (1.0, 0, 60, -2.0, 1.0)):
            with self.assertRaises(ValueError):
                compare_baseline_scenario(*args)

    def test_scheduled_minutes_handles_day_boundaries(self):
        # 23:00 day 1 -> 01:00 day 2 against a 00:00-02:00 daily schedule
        self.assertAlmostEqual(
            scheduled_minutes_between(1380, 1500, 0, 2), 60.0)
        # a full day of schedule
        self.assertAlmostEqual(
            scheduled_minutes_between(0, 1440, 0, 24), 1440.0)
        # no overlap
        self.assertAlmostEqual(
            scheduled_minutes_between(0, 120, 9, 17), 0.0)


if __name__ == "__main__":
    unittest.main()
