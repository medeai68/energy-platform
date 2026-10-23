"""Historical energy playback for the building hierarchy (stdlib only).

Purpose
-------
Turn the simulation engine's per-device tick history into a day of energy
buckets for every room, floor and building, so the UI can scrub through time
and render room/floor heatmaps.

Inputs
------
* a normal ``SimulationEngine.snapshot()`` tree for space areas and device
  membership (unique membership: a device belongs to exactly one place);
* a mapping ``{device_id: [(abs_minutes, actual_kw), ...]}`` of device
  histories.

Method
------
For each space the member devices' power series are summed per timestamp and
integrated with the same trapezoidal rule used by
:mod:`equipment.calculations`:

    E_bucket = Σ ((P_i + P_i+1) / 2) × Δt / 60

Intervals crossing a bucket boundary are split at the boundary, so energy is
attributed to the correct bucket.  Intervals longer than
``max_gap_minutes`` (default one day) are skipped.  A bucket with no coverage
returns ``energy_kwh=None`` - the UI shows an empty state rather than a
fabricated zero.

All figures are calculated from simulated history; they are never presented as
metered readings.
"""

from __future__ import annotations

import math

MIN_BUCKET_MINUTES = 5.0
MAX_BUCKET_MINUTES = 1440.0
MINUTES_PER_DAY = 1440.0
MAX_DAY = 100000

_NOTE = ("Historical playback: trapezoidal integration of simulated device "
         "history - calculated, not metered consumption.")


def _number(value, field):
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a number")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a number") from None
    if not math.isfinite(number):
        raise ValueError(f"{field} must be a finite number")
    return number


def validate_bucket_minutes(value):
    """Return a validated bucket size in minutes (5..1440)."""
    bucket = _number(value, "bucket")
    if bucket < MIN_BUCKET_MINUTES or bucket > MAX_BUCKET_MINUTES:
        raise ValueError(
            f"bucket must be between {MIN_BUCKET_MINUTES:g} and "
            f"{MAX_BUCKET_MINUTES:g} minutes")
    return bucket


def validate_day(value):
    """Return a validated simulation day (integer >= 1)."""
    if isinstance(value, bool):
        raise ValueError("day must be a positive integer")
    try:
        day = int(value)
    except (TypeError, ValueError):
        raise ValueError("day must be a positive integer") from None
    if isinstance(value, float) and not value.is_integer():
        raise ValueError("day must be a positive integer")
    if str(value).strip() not in {str(day), f"{day}.0"} and not isinstance(value, int):
        raise ValueError("day must be a positive integer")
    if day < 1 or day > MAX_DAY:
        raise ValueError(f"day must be between 1 and {MAX_DAY}")
    return day


def _clock(abs_minutes):
    """HH:MM for an absolute-minute timestamp (day 1 starts at 00:00)."""
    minutes = int(round(abs_minutes)) % 1440
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _clean_series(series):
    """Finite, non-negative (time, power) pairs sorted with last-write-wins."""
    cleaned = {}
    for sample in series or ():
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
        if power < 0:
            continue
        cleaned[t] = power
    return sorted(cleaned.items())


def _interpolate(t0, p0, t1, p1, t):
    if t1 <= t0:
        return p0
    return p0 + (p1 - p0) * ((t - t0) / (t1 - t0))


def space_inventory(snapshot):
    """Unique place/device membership for every building, floor and room.

    Returns a list of dictionaries.  Roof PV equipment is deliberately not
    part of consumption spaces.  ``device_ids`` are unique within a space and
    each device is a member of exactly one room, floor or building, matching
    the engine's no-double-counting rule.
    """
    spaces = []
    for building in (snapshot or {}).get("buildings") or []:
        b_id = building.get("id")
        building_ids = set()
        for floor in building.get("floors") or []:
            f_id = floor.get("id")
            floor_ids = set()
            for room in floor.get("rooms") or []:
                device_ids = [d.get("id") for d in room.get("devices") or ()
                              if d.get("id")]
                floor_ids.update(device_ids)
                spaces.append({
                    "id": room.get("id"),
                    "kind": "room",
                    "name": room.get("name") or room.get("id"),
                    "area": _safe_area(room.get("area")),
                    "building_id": b_id,
                    "floor_id": f_id,
                    "room_id": room.get("id"),
                    "parent_id": f_id,
                    "device_ids": sorted(set(device_ids)),
                })
            fcu = floor.get("fcu") or {}
            if fcu.get("id"):
                floor_ids.add(fcu["id"])
            spaces.append({
                "id": f_id,
                "kind": "floor",
                "name": floor.get("name") or f_id,
                "area": _safe_area(floor.get("area")),
                "building_id": b_id,
                "floor_id": f_id,
                "room_id": None,
                "parent_id": b_id,
                "device_ids": sorted(floor_ids),
            })
            building_ids.update(floor_ids)
        for device in building.get("equipment") or ():
            if device.get("id"):
                building_ids.add(device["id"])
        spaces.append({
            "id": b_id,
            "kind": "building",
            "name": building.get("name") or b_id,
            "area": _safe_area(building.get("area")),
            "building_id": b_id,
            "floor_id": None,
            "room_id": None,
            "parent_id": None,
            "device_ids": sorted(building_ids),
        })
    return spaces


def _safe_area(value):
    try:
        area = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(area) or area < 0:
        return 0.0
    return area


def aggregate_series(series_by_device, device_ids):
    """Sum multiple device power series per timestamp.

    Each device's duplicate timestamps collapse to the last value (the same
    canonical rule as measurements), then device values are summed.  The
    result is sorted by time.
    """
    totals = {}
    for device_id in device_ids or ():
        for t, power in _clean_series((series_by_device or {}).get(device_id)):
            totals[t] = totals.get(t, 0.0) + power
    return sorted(totals.items())


def bucket_energy(series, bucket_minutes=60, day=1, max_gap_minutes=None):
    """Integrate a power series into fixed buckets for one simulation day.

    Returns a dictionary with ``buckets`` (one entry per interval including
    empty buckets), coverage metadata and skipped-gap counts.  Bucket values
    are ``None`` when no interval covered that bucket.
    """
    bucket = validate_bucket_minutes(bucket_minutes)
    day = validate_day(day)
    gap_limit = MINUTES_PER_DAY
    if max_gap_minutes is not None:
        gap_limit = _number(max_gap_minutes, "max_gap_minutes")
        if gap_limit <= 0:
            raise ValueError("max_gap_minutes must be > 0")

    day_start = (day - 1) * MINUTES_PER_DAY
    day_end = day_start + MINUTES_PER_DAY
    count = int(math.ceil(MINUTES_PER_DAY / bucket))
    energy = [0.0] * count
    covered = [0.0] * count
    skipped = 0
    used_intervals = 0
    samples_in_day = 0

    cleaned = _clean_series(series)
    samples_in_day = sum(1 for t, _ in cleaned if day_start <= t <= day_end)

    for (t0, p0), (t1, p1) in zip(cleaned, cleaned[1:]):
        dt = t1 - t0
        if dt <= 0:
            continue
        if dt > gap_limit:
            skipped += 1
            continue
        start = max(t0, day_start)
        end = min(t1, day_end)
        if end <= start + 1e-12:
            continue
        used_intervals += 1
        cursor = start
        while cursor < end - 1e-12:
            index = int((cursor - day_start) // bucket)
            if index < 0:
                index = 0
            elif index >= count:
                index = count - 1
            segment_end = min(end, day_start + (index + 1) * bucket)
            if segment_end <= cursor + 1e-12:
                break
            power_a = _interpolate(t0, p0, t1, p1, cursor)
            power_b = _interpolate(t0, p0, t1, p1, segment_end)
            energy[index] += ((power_a + power_b) / 2.0) * (
                (segment_end - cursor) / 60.0)
            covered[index] += segment_end - cursor
            cursor = segment_end

    buckets = []
    for index in range(count):
        start = day_start + index * bucket
        end = min(day_start + MINUTES_PER_DAY, start + bucket)
        capacity = end - start
        minutes = covered[index]
        entry = {
            "t": start,
            "time": _clock(start),
            "energy_kwh": None,
            "mean_kw": None,
            "covered_minutes": round(minutes, 3),
            "coverage": round(minutes / capacity, 3) if capacity > 0 else 0.0,
        }
        if minutes > 1e-9:
            entry["energy_kwh"] = round(energy[index], 6)
            entry["mean_kw"] = round(energy[index] / (minutes / 60.0), 6)
        buckets.append(entry)

    return {
        "day": day,
        "bucket_minutes": bucket,
        "day_start_minutes": day_start,
        "day_end_minutes": day_end,
        "buckets": buckets,
        "total_energy_kwh": round(sum(energy), 6),
        "covered_minutes": round(sum(covered), 3),
        "used_intervals": used_intervals,
        "skipped_intervals": skipped,
        "samples_in_day": samples_in_day,
    }


def build_playback(snapshot, series_by_device, bucket_minutes=60, day=None):
    """Build a full playback payload for every space in the hierarchy.

    The response contains a fixed day timeline and one series per space
    aligned to that timeline.  ``max_intensity_kwh_m2`` is the global colour
    scale across the whole day so heatmap colours stay comparable while
    scrubbing.  There is no measured data here: every value is a calculation
    over simulated history.
    """
    snapshot = snapshot or {}
    bucket = validate_bucket_minutes(bucket_minutes)
    if day is None:
        day = (snapshot.get("sim") or {}).get("day", 1)
    day = validate_day(day)

    inventory = space_inventory(snapshot)
    spaces = []
    max_intensity = 0.0
    max_energy = 0.0
    total_covered = 0.0
    skipped = 0
    for space in inventory:
        series = aggregate_series(series_by_device, space["device_ids"])
        result = bucket_energy(series, bucket, day)
        area = space["area"]
        values = []
        for bucket_entry in result["buckets"]:
            energy = bucket_entry["energy_kwh"]
            intensity = None
            if energy is not None and area > 0:
                intensity = round(energy / area, 8)
                max_intensity = max(max_intensity, intensity)
            if energy is not None:
                max_energy = max(max_energy, energy)
            values.append({
                "time": bucket_entry["time"],
                "energy_kwh": energy,
                "mean_kw": bucket_entry["mean_kw"],
                "intensity_kwh_m2": intensity,
                "covered_minutes": bucket_entry["covered_minutes"],
                "coverage": bucket_entry["coverage"],
            })
        skipped += result["skipped_intervals"]
        total_covered = max(total_covered, result["covered_minutes"])
        spaces.append({
            **space,
            "total_energy_kwh": result["total_energy_kwh"],
            "covered_minutes": result["covered_minutes"],
            "series": values,
        })

    timeline = []
    if inventory:
        count = len(spaces[0]["series"]) if spaces else 0
        for index in range(count):
            first = spaces[0]["series"][index]
            bucket_energy_max = 0.0
            bucket_intensity_max = 0.0
            bucket_has_data = False
            for space in spaces:
                entry = space["series"][index]
                if entry["energy_kwh"] is not None:
                    bucket_has_data = True
                    bucket_energy_max = max(bucket_energy_max,
                                            entry["energy_kwh"])
                if entry["intensity_kwh_m2"] is not None:
                    bucket_intensity_max = max(bucket_intensity_max,
                                               entry["intensity_kwh_m2"])
            timeline.append({
                "t": result["day_start_minutes"] + index * bucket if spaces else 0,
                "time": first["time"],
                "has_data": bucket_has_data,
                "max_energy_kwh": round(bucket_energy_max, 6),
                "max_intensity_kwh_m2": round(bucket_intensity_max, 8),
            })

    return {
        "day": day,
        "bucket_minutes": bucket,
        "bucket_count": len(timeline),
        "day_start_minutes": (day - 1) * MINUTES_PER_DAY,
        "day_end_minutes": day * MINUTES_PER_DAY,
        "timeline": timeline,
        "spaces": spaces,
        "max_intensity_kwh_m2": round(max_intensity, 8),
        "max_energy_kwh": round(max_energy, 6),
        "covered_minutes": round(total_covered, 3),
        "skipped_intervals": skipped,
        "basis": "calculated",
        "power_source": "simulated_history",
        "formula": "E = Σ ((P_i + P_i+1) / 2) × Δt / 60",
        "note": _NOTE,
    }
