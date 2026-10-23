"""Documented, unit-consistent energy calculations (stdlib only).

Four quantities are kept strictly separate
------------------------------------------
``rated_power_kw``
    Nameplate power from the equipment registry. A capacity, never a
    consumption.
``measured_power_kw``
    One instantaneous power reading from a sensor/meter (in this prototype
    the digital twin's virtual sensor).  kW.
``simulated_energy_kwh``
    Energy integrated by the simulation engine's own counter.  A simulation
    output - not a meter register and not a measurement.
``calculated_energy_kwh``
    Energy derived from measured power with the formulas below.  Always an
    estimate; every result carries ``basis="calculated"`` and must never be
    labelled or presented as measured electrical consumption.

Units
-----
power   kW
time    h  (simulation timestamps are absolute minutes; divide by 60)
energy  kWh

Constant-power formula
----------------------
    E = P x t

Used when the measured power is approximately constant over the window:

    (max(P) - min(P)) / mean(P) <= CONSTANT_POWER_REL_RANGE   (10 %)

The operating time ``t`` is the covered measurement-window duration (sum of
the accepted sample intervals), in hours.

Variable-power formula
----------------------
    E = sum_i ((P_i + P_i+1) / 2) x (t_i+1 - t_i) / 60

Trapezoidal integration of measured power over the measurement timestamps.
Intervals longer than ``max_gap_minutes`` are skipped because the data does
not support an estimate across that gap.  Fewer than two usable samples, or
no usable interval, yields ``status != "ok"`` and ``energy_kwh=None`` so
callers render an empty state instead of inventing a number.

Scenario estimate (constant power, with optional load factor)
--------------------------------------------------------------
    E_scenario = rated_power_kw x load_factor x operating_hours

for one day; the monthly figure assumes 30 days.  ``load_factor`` (0..1)
represents average power as a fraction of nameplate.  The optional
``schedule_start`` places the configured operating hours inside the day
(00:00-24:00); it does not change the daily total, but it is used when a
scenario is compared with a baseline window at a particular time of day.

Baseline vs scenario comparison
-------------------------------
The scenario window figure applies the configured rating, load factor and
schedule to the *same* measurement window as the baseline, so the two numbers
have the same duration.  Both are calculated estimates; the comparison never
claims measured consumption.

All results include the method, formula, window, sample count and thresholds
so an estimate can be audited.
"""

from __future__ import annotations

import math

#: A measured series is "approximately constant" when its relative range
#: (max - min) / mean is at or below this fraction.
CONSTANT_POWER_REL_RANGE = 0.10

#: Two samples are the minimum for any interval; variable-power integration
#: needs one interval and the constant-power check needs both endpoints.
MIN_SAMPLES = 2

#: Scenario bounds (documented and enforced by the API/store).
MAX_RATED_KW = 100000.0
MAX_OPERATING_HOURS = 24.0
MAX_LOAD_FACTOR = 1.0
DAYS_PER_MONTH = 30.0
MINUTES_PER_DAY = 1440.0

_FORMULA_CONSTANT = "E = P × t"
_FORMULA_CONSTANT_LOAD = "E = P × t × LF"
_FORMULA_VARIABLE = "E = Σ ((P_i + P_i+1) / 2) × Δt / 60"
_NOTE = ("Calculated estimate derived from measured power using the documented "
         "formula - not a metered reading.")


def _as_number(value, field):
    """Finite float or ValueError with a field-specific message."""
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a number")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a number") from None
    if not math.isfinite(number):
        raise ValueError(f"{field} must be a finite number")
    return number


def _clean_series(samples):
    """Normalise (timestamp_minutes, power_kw) pairs.

    Invalid / non-finite entries are dropped, duplicate timestamps collapse to
    the last value (matching the canonical measurement UPSERT rule), and the
    result is sorted by time.
    """
    cleaned = {}
    for sample in samples or ():
        try:
            t, power = sample
        except (TypeError, ValueError):
            continue
        if t is None or power is None:
            continue
        try:
            t = float(t)
            power = float(power)
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(t) and math.isfinite(power)):
            continue
        cleaned[t] = power
    return sorted(cleaned.items())


def constant_power_energy(power_kw, hours):
    """E = P x t for an approximately constant load.

    ``power_kw`` and ``hours`` must be non-negative finite numbers.
    """
    power = _as_number(power_kw, "power_kw")
    time_h = _as_number(hours, "hours")
    if power < 0:
        raise ValueError("power_kw must be >= 0")
    if time_h < 0:
        raise ValueError("hours must be >= 0")
    return power * time_h


def validate_scenario(rated_kw, operating_hours):
    """Validate scenario inputs; returns (rated_kw, operating_hours)."""
    rated = _as_number(rated_kw, "rated_kw")
    hours = _as_number(operating_hours, "operating_hours")
    if rated < 0 or rated > MAX_RATED_KW:
        raise ValueError(f"rated_kw must be between 0 and {MAX_RATED_KW:g}")
    if hours < 0 or hours > MAX_OPERATING_HOURS:
        raise ValueError(
            f"operating_hours must be between 0 and {MAX_OPERATING_HOURS:g}")
    return rated, hours


def validate_scenario_config(rated_kw, operating_hours, load_factor=1.0,
                             schedule_start=0.0):
    """Validate a full simulated-equipment scenario; returns a config dict.

    ``rated_kw`` / ``operating_hours`` keep the bounds enforced by
    :func:`validate_scenario`.  ``load_factor`` is the average fraction of
    nameplate power (0..1).  ``schedule_start`` is the hour of day at which
    the daily operating window begins; the window may not run past midnight.
    """
    rated, hours = validate_scenario(rated_kw, operating_hours)
    load = _as_number(load_factor, "load_factor")
    start = _as_number(schedule_start, "schedule_start")
    if load < 0 or load > MAX_LOAD_FACTOR:
        raise ValueError(
            f"load_factor must be between 0 and {MAX_LOAD_FACTOR:g}")
    if start < 0 or start > MAX_OPERATING_HOURS:
        raise ValueError(
            f"schedule_start must be between 0 and {MAX_OPERATING_HOURS:g}")
    if hours > 0 and start + hours > MAX_OPERATING_HOURS + 1e-9:
        raise ValueError(
            "schedule_start + operating_hours must be <= 24")
    return {
        "rated_kw": rated,
        "operating_hours": hours,
        "load_factor": load,
        "schedule_start": start,
    }


def _hour_label(hour):
    """Render an hour-of-day fraction as HH:MM (24:00 allowed)."""
    total = int(round(float(hour) * 60.0))
    return f"{total // 60:02d}:{total % 60:02d}"


def scheduled_minutes_between(window_start, window_end, schedule_start,
                              schedule_end):
    """Minutes of schedule that overlap an absolute-minute measurement window.

    ``window_start`` / ``window_end`` are simulation minutes from day 1 00:00;
    the schedule is a daily time-of-day range ``[schedule_start, schedule_end]``
    in hours.  Windows spanning midnight are handled by walking day
    boundaries.  The schedule must not wrap past midnight (enforced by
    :func:`validate_scenario_config`).
    """
    start = _as_number(window_start, "window_start")
    end = _as_number(window_end, "window_end")
    sched_start = _as_number(schedule_start, "schedule_start")
    sched_end = _as_number(schedule_end, "schedule_end")
    if end <= start:
        return 0.0
    if sched_end <= sched_start:
        return 0.0
    total = 0.0
    cursor = start
    while cursor < end - 1e-9:
        day_start = math.floor(cursor / MINUTES_PER_DAY) * MINUTES_PER_DAY
        day_end = day_start + MINUTES_PER_DAY
        segment_end = min(end, day_end)
        overlap_start = max(cursor, day_start + sched_start * 60.0)
        overlap_end = min(segment_end, day_start + sched_end * 60.0)
        if overlap_end > overlap_start:
            total += overlap_end - overlap_start
        cursor = segment_end
    return total


def scenario_energy(rated_kw, operating_hours, load_factor=1.0,
                    schedule_start=0.0):
    """Constant-power scenario estimate with an optional load factor.

    ``E = rated power x load factor x operating hours`` for one day; the
    monthly figure assumes 30 identical days.  Defaults preserve the original
    Step 7 behaviour (``load_factor=1``, schedule starting at 00:00).  Both
    figures are calculated scenario estimates, never measured consumption.
    """
    config = validate_scenario_config(
        rated_kw, operating_hours, load_factor, schedule_start)
    rated = config["rated_kw"]
    hours = config["operating_hours"]
    load = config["load_factor"]
    start = config["schedule_start"]
    effective_kw = rated * load
    daily = constant_power_energy(effective_kw, hours)
    end = start + hours
    formula = _FORMULA_CONSTANT if load == 1.0 else _FORMULA_CONSTANT_LOAD
    assumption = (
        "Continuous operation at rated power for the configured daily "
        "hours; monthly = 30 identical days."
    )
    if load != 1.0:
        assumption = (
            f"Continuous operation at {load:.0%} of rated power for the "
            "configured daily hours; monthly = 30 identical days."
        )
    if hours > 0 and start > 0:
        assumption += (
            f" Daily window assumed {_hour_label(start)}-{_hour_label(end)}.")
    return {
        "rated_kw": round(rated, 6),
        "operating_hours": round(hours, 6),
        "load_factor": round(load, 6),
        "effective_power_kw": round(effective_kw, 6),
        "schedule_start": round(start, 6),
        "schedule_end": round(end, 6),
        "schedule_label": (_hour_label(start) + "–" + _hour_label(end)
                           if hours > 0 else "Not scheduled"),
        "daily_energy_kwh": round(daily, 6),
        "monthly_energy_kwh": round(daily * DAYS_PER_MONTH, 6),
        "method": "constant_power",
        "method_label": ("Constant power" if load == 1.0
                         else "Constant power × load factor"),
        "formula": formula,
        "basis": "calculated",
        "assumption": assumption,
        "note": "Scenario estimate - calculated, not measured consumption.",
    }


def compare_baseline_scenario(baseline_kwh, baseline_start_minutes,
                              baseline_end_minutes, rated_kw,
                              operating_hours, load_factor=1.0,
                              schedule_start=0.0, covered_hours=None):
    """Compare calculated baseline energy with a hypothetical scenario.

    The scenario is applied to the *same* window as the baseline: only the
    part of the configured daily schedule that overlaps the baseline window
    contributes, so short and long baselines are compared like-for-like.
    ``covered_hours`` (from ``calculate_energy``) limits the scenario runtime
    to the portion of the window actually supported by data.
    Both figures are estimates (``basis="calculated_comparison"``); this
    function never produces or claims a measured reading.
    """
    baseline = _as_number(baseline_kwh, "baseline_kwh")
    if baseline < 0:
        raise ValueError("baseline_kwh must be >= 0")
    start = _as_number(baseline_start_minutes, "baseline_start_minutes")
    end = _as_number(baseline_end_minutes, "baseline_end_minutes")
    if end <= start:
        raise ValueError("baseline window must have a positive duration")
    scenario = scenario_energy(
        rated_kw, operating_hours, load_factor, schedule_start)
    hours = (end - start) / 60.0
    scheduled_minutes = scheduled_minutes_between(
        start, end, scenario["schedule_start"], scenario["schedule_end"])
    # The baseline number comes from *covered* intervals; never claim more
    # scenario runtime than the baseline actually covers, even if the
    # window span (which may include skipped gaps) is longer.
    scheduled_hours = min(scheduled_minutes / 60.0, hours)
    if covered_hours is not None:
        covered = _as_number(covered_hours, "covered_hours")
        if covered < 0:
            raise ValueError("covered_hours must be >= 0")
        scheduled_hours = min(scheduled_hours, covered)
    scenario_window = scenario["effective_power_kw"] * scheduled_hours
    delta = scenario_window - baseline
    delta_pct = None
    if baseline > 1e-9:
        delta_pct = round(delta / baseline * 100.0, 6)
    return {
        "baseline": {
            "energy_kwh": round(baseline, 6),
            "window_start_minutes": start,
            "window_end_minutes": end,
            "window_hours": round(hours, 6),
            "basis": "calculated",
        },
        "scenario": scenario,
        "window": {
            "hours": round(hours, 6),
            "covered_hours": (round(covered_hours, 6)
                              if covered_hours is not None else None),
            "scheduled_hours": round(scheduled_hours, 6),
            "scenario_energy_kwh": round(scenario_window, 6),
            "delta_kwh": round(delta, 6),
            "delta_percent": delta_pct,
            "direction": ("higher" if delta > 1e-9 else
                          "lower" if delta < -1e-9 else "equal"),
            "savings_kwh": round(max(baseline - scenario_window, 0.0), 6),
        },
        "basis": "calculated_comparison",
        "note": ("Same-window comparison of calculated estimates; both "
                 "figures are not metered consumption."),
    }


def calculate_energy(samples, max_gap_minutes=None,
                     constant_rel_range=CONSTANT_POWER_REL_RANGE):
    """Estimate energy from a measured-power series.

    ``samples`` is an iterable of ``(timestamp_minutes, power_kw)``.  The
    method is selected automatically and reported in the result:

    * approximately constant power (relative range <= ``constant_rel_range``):
      ``E = mean(P) * window_hours``  (the constant-power formula),
    * otherwise: trapezoidal integration of measured power over time.

    Returns a dictionary that always contains ``basis="calculated"``,
    ``status`` (``ok`` / ``insufficient_data`` / ``no_continuous_window``),
    the method and formula used, the window metadata, and ``energy_kwh``
    (``None`` when the data does not support a calculation).
    """
    series = _clean_series(samples)
    max_gap = None
    if max_gap_minutes is not None:
        max_gap = _as_number(max_gap_minutes, "max_gap_minutes")
        if max_gap <= 0:
            raise ValueError("max_gap_minutes must be > 0")

    result = {
        "basis": "calculated",
        "energy_kwh": None,
        "status": "insufficient_data",
        "reason": f"needs at least {MIN_SAMPLES} measured samples",
        "method": None,
        "method_label": None,
        "formula": None,
        "samples": len(series),
        "used_samples": 0,
        "duration_hours": 0.0,
        "skipped_intervals": 0,
        "window": None,
        "mean_power_kw": None,
        "min_power_kw": None,
        "max_power_kw": None,
        "relative_range": None,
        "thresholds": {
            "constant_power_max_relative_range": constant_rel_range,
            "max_gap_minutes": max_gap,
        },
        "note": _NOTE,
    }
    if len(series) < MIN_SAMPLES:
        return result

    # Build the usable intervals.  A gap longer than max_gap_minutes is
    # skipped: we do not claim an estimate across data we do not have.
    intervals = []
    skipped = 0
    for (t0, p0), (t1, p1) in zip(series, series[1:]):
        dt = t1 - t0
        if dt <= 0:
            continue
        if max_gap is not None and dt > max_gap:
            skipped += 1
            continue
        intervals.append((t0, p0, t1, p1, dt))

    if not intervals:
        result.update({
            "status": "no_continuous_window",
            "reason": ("no measurement interval is short enough to support an "
                       "estimate"),
            "skipped_intervals": skipped,
        })
        return result

    used_times = set()
    for t0, _, t1, _, _ in intervals:
        used_times.add(t0)
        used_times.add(t1)
    used_values = [power for t, power in series if t in used_times]

    mean_power = sum(used_values) / len(used_values)
    relative_range = 0.0
    if mean_power > 1e-12:
        relative_range = (max(used_values) - min(used_values)) / mean_power
    duration_hours = sum(dt for _, _, _, _, dt in intervals) / 60.0
    start = intervals[0][0]
    end = intervals[-1][2]

    common = {
        "samples": len(series),
        "used_samples": len(used_values),
        "duration_hours": round(duration_hours, 6),
        "skipped_intervals": skipped,
        "window": {
            "start_minutes": start,
            "end_minutes": end,
            "duration_hours": round(duration_hours, 6),
        },
        "mean_power_kw": round(mean_power, 6),
        "min_power_kw": round(min(used_values), 6),
        "max_power_kw": round(max(used_values), 6),
        "relative_range": round(relative_range, 6),
    }

    if relative_range <= constant_rel_range:
        # E = P x t with operating time taken from the covered window.
        energy = mean_power * duration_hours
        result.update(common)
        result.update({
            "status": "ok",
            "reason": None,
            "method": "constant_power",
            "method_label": "Constant power",
            "formula": _FORMULA_CONSTANT,
            "energy_kwh": round(energy, 6),
        })
        return result

    # Trapezoidal integration of measured power over time.
    energy = 0.0
    for _, p0, _, p1, dt in intervals:
        energy += ((p0 + p1) / 2.0) * (dt / 60.0)
    result.update(common)
    result.update({
        "status": "ok",
        "reason": None,
        "method": "variable_integration",
        "method_label": "Variable-power integration",
        "formula": _FORMULA_VARIABLE,
        "energy_kwh": round(energy, 6),
    })
    return result
