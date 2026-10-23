"""Simulation engine for the energy platform digital twin.

Models a small commercial building with rooftop solar:
  - 50 kWp solar array, 50 kW inverter
  - 3x 12 kW HVAC units, 6 kW lighting, 9 kW plug loads
  - grid connection (import / export)

Every device produces two numbers each tick:
  expected -> what the *healthy* model predicts for current conditions
  actual   -> the virtual sensor reading (expected + fault effects + noise)

Pure standard library - no numpy/pandas needed.
"""

import math
import random
import threading
import time
from collections import deque

from .faults import faults_for

DAY_MINUTES = 24 * 60
SUNRISE = 6.0
SUNSET = 18.5

# ---------------- Weather ----------------


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


class Weather:
    """Cloud cover (0..1) and outdoor temperature model."""

    def __init__(self):
        self.mode = "auto"  # auto | clear | partly | cloudy | overcast
        self.cloud = 0.2
        self._targets = {
            "auto": None,
            "clear": 0.05,
            "partly": 0.30,
            "cloudy": 0.55,
            "overcast": 0.85,
        }

    def step(self, minutes):
        target = self._targets[self.mode]
        pull = 0.0 if target is None else (target - self.cloud) * 0.012
        self.cloud = clamp(self.cloud + random.gauss(0, 0.02) + pull, 0.0, 1.0)

    def daylight(self, hour):
        """Clear-sky irradiance fraction 0..1."""
        if hour < SUNRISE or hour > SUNSET:
            return 0.0
        return max(0.0, math.sin(math.pi * (hour - SUNRISE) / (SUNSET - SUNRISE)))

    def temp_out(self, hour):
        """Outdoor temperature (C) over the day."""
        if 5.0 <= hour < 18.0:
            base = 23.0 + 7.0 * math.sin(math.pi * (hour - 5.0) / 13.0)
        else:
            h = hour if hour >= 18.0 else hour + 24.0
            base = 23.0 - 3.0 * math.sin(math.pi * (h - 18.0) / 16.0)
        return base - 4.5 * self.cloud * self.daylight(hour)


# ---------------- Devices ----------------


class Device:
    """Base device. Subclasses define the healthy model and fault behavior."""

    kind = "generic"
    noise_frac = 0.03     # relative noise on the actual reading
    rel_floor = 1.0       # kW floor for relative-residual math
    anomaly_thresh = 0.10  # |rel| above this is anomalous

    def __init__(self, dev_id, name, rating_kw):
        self.id = dev_id
        self.name = name
        self.rating = rating_kw
        self.faults = set()
        self.expected = 0.0
        self.actual = 0.0
        self.history = deque(maxlen=240)  # (abs_minutes, expected, actual)
        # --- equipment data model ---
        self.source = "simulated"     # live | imported | simulated
        self.building_id = None
        self.floor_id = None
        self.room_id = None
        self.energy_today_kwh = 0.0   # since the last sim midnight
        self.operating_hours = 0.0    # cumulative while running
        self.last_measured = None     # sim absolute minutes
        self._stuck_value = None      # sensor_stuck capture

    # --- model ---

    def expected_power(self, env):
        raise NotImplementedError

    def actual_power(self, env):
        e = self.expected_power(env)
        a = self.apply_faults(e, env)
        noise = random.gauss(0.0, self.noise_frac * max(e, self.rating * 0.05))
        return max(0.0, a + noise)

    def apply_faults(self, e, env):
        return e

    # --- per-tick bookkeeping ---

    def step(self, env):
        self.expected = self.expected_power(env)
        self.actual = self.actual_power(env)
        self.history.append((env["abs_minutes"], self.expected, self.actual))

    def set_fault(self, fault_id, active):
        if active:
            self.faults.add(fault_id)
            if fault_id == "sensor_stuck":
                # freeze at the reading the platform holds right now
                self._stuck_value = self.actual
        else:
            self.faults.discard(fault_id)
        if fault_id == "sensor_stuck" and not active:
            self._stuck_value = None

    def apply_sensor_faults(self):
        """Sensor-layer faults distort the *measurement* only. The physical
        equipment may be healthy; the platform records what the sensor
        reports, so energy metering and the detector both see the corrupted
        reading (and the detector flags it like any deviation)."""
        if "sensor_stuck" in self.faults:
            if self._stuck_value is None:
                self._stuck_value = self.actual
            self.actual = self._stuck_value
        elif "sensor_drift" in self.faults:
            # No clamp here: the battery's actual is a signed charge/discharge
            # flow, so a +35% meter bias must preserve its direction.
            self.actual = self.actual * 1.35

    # --- metering ---

    def account(self, dt_h, abs_minutes):
        """Integrate energy and runtime for the elapsed sim interval."""
        self.energy_today_kwh += self.actual * dt_h
        if self.actual > 0.05:
            self.operating_hours += dt_h
        self.last_measured = abs_minutes

    def reset_daily_energy(self):
        self.energy_today_kwh = 0.0

    def attributes(self):
        """Equipment-specific static fields (stored with the registry)."""
        return {}

    # --- API serialization ---

    def status(self):
        return "ok"  # overridden by detector via device_state

    def extra(self, env):
        return {}


class BatteryStorage(Device):
    """Campus-level battery storage (40 kW, 120 kWh usable).

    Charges from solar surplus and discharges to cover load, limited by the
    charge/discharge rate and the state-of-charge window (10%..95%).
    ``expected`` is the healthy schedule; the injected faults shrink
    ``actual`` against it, so the detector flags them like any deviation.
    ``actual`` is the signed storage flow: positive = charging, negative =
    discharging. Energy metering records the net flow (charge minus
    discharge); the attributes carry both directions separately.
    """

    anomaly_thresh = 0.10

    def __init__(self):
        super().__init__("battery", "Battery Storage", 40.0)
        self.kind = "battery_storage"
        self.capacity_kwh = 120.0
        self.soc_kwh = 36.0          # 30% at boot
        self.charge_rate = 40.0      # kW
        self.discharge_rate = 40.0   # kW
        self.charged_today_kwh = 0.0
        self.discharged_today_kwh = 0.0
        self.rel_floor = 10.0

    def _flow(self, surplus_kw, cap_frac, allow_charge, dt_h):
        soc_cap = self.capacity_kwh * cap_frac
        floor = self.capacity_kwh * 0.10
        if surplus_kw > 0 and allow_charge:
            want = min(surplus_kw, self.charge_rate)
            room = max(0.0, soc_cap - self.soc_kwh)
            return min(want, room / max(dt_h, 1e-6))
        if surplus_kw < 0:
            need = min(-surplus_kw, self.discharge_rate)
            available = max(0.0, self.soc_kwh - floor)
            return -min(need, available / max(dt_h, 1e-6))
        return 0.0

    def step(self, env, surplus_kw, dt_h):
        healthy = self._flow(surplus_kw, 0.95, True, dt_h)
        cap = 0.60 if "reduced_capacity" in self.faults else 0.95
        allow = "charge_fault" not in self.faults
        faulted = self._flow(surplus_kw, cap, allow, dt_h)
        self.expected = healthy
        self.actual = faulted
        self.soc_kwh = max(0.0, min(self.capacity_kwh,
                                    self.soc_kwh + faulted * dt_h))
        if faulted > 0:
            self.charged_today_kwh += faulted * dt_h
        if faulted < 0:
            self.discharged_today_kwh += -faulted * dt_h
        self.history.append((env["abs_minutes"], self.expected, self.actual))

    def reset_daily_energy(self):
        super().reset_daily_energy()
        self.charged_today_kwh = 0.0
        self.discharged_today_kwh = 0.0

    def extra(self, env):
        return {
            "soc_pct": round(100.0 * self.soc_kwh / self.capacity_kwh, 0),
            "capacity_kwh": self.capacity_kwh,
            "charged_today_kwh": round(self.charged_today_kwh, 2),
            "discharged_today_kwh": round(self.discharged_today_kwh, 2),
        }


class SolarArray(Device):
    """50 kWp rooftop array. Output follows irradiance with temperature derating.

    The array's *actual* output is the sum of the 48 individual
    :class:`SolarPanel` modules simulated by the engine (see
    ``SimulationEngine.tick``). Array-level faults (soiling, shading, ...)
    shrink every panel's baseline through ``fault_factor``, so they keep
    raising the array-level anomaly exactly as before panel-level modelling.
    """

    kind = "solar"
    noise_frac = 0.03
    rel_floor = 8.0
    anomaly_thresh = 0.12

    _FAULT_FACTORS = {
        "soiling": 0.85,
        "shading": 0.72,
        "degradation": 0.90,
        "panel_failure": 0.60,
    }

    def expected_power(self, env):
        ghi = env["ghi"]
        if ghi <= 0:
            return 0.0
        t_cell = env["temp_out"] + 28.0 * ghi
        derate = 1.0 - 0.004 * (t_cell - 25.0)
        return self.rating * ghi * max(derate, 0.75)

    def fault_factor(self):
        factor = 1.0
        for f in self.faults:
            factor *= self._FAULT_FACTORS.get(f, 1.0)
        return factor

    def apply_faults(self, e, env):
        return e * self.fault_factor()

    def extra(self, env):
        return {
            "ghi": round(env["ghi"], 2),
            "cell_temp": round(env["temp_out"] + 28.0 * env["ghi"], 1),
        }

    def attributes(self):
        return {"modules": 48, "technology": "monocrystalline"}


class SolarPanel(Device):
    """Individual PV module (1 of 48) on the rooftop array.

    Each panel has a stable identity (id, row, column) and its own fault
    state. Its expected output is the panel's share of the array's expected
    generation (array-level faults included, so array faults don't re-fire
    as per-panel anomalies) scaled by a fixed per-panel quality factor.
    Panel-level faults only affect this panel's *actual* reading.

    The engine drives panels via ``step()`` with ``env["panel_base_kw"]``
    set to one panel's share; ``expected_power``/``actual_power`` are not
    used.
    """

    kind = "panel"
    noise_frac = 0.02
    rel_floor = 0.2
    anomaly_thresh = 0.10

    _FAULT_FACTORS = {
        "reduced_output": 0.85,
        "overheating": 0.72,
        "disconnected": 0.0,
    }

    OVERHEAT_DELTA_C = 25.0

    def __init__(self, dev_id, name, row, col, rating_kw, quality):
        super().__init__(dev_id, name, rating_kw)
        self.row = row
        self.col = col
        self.quality = quality

    def step(self, env):
        self.expected = env["panel_base_kw"] * self.quality
        factor = 1.0
        for f in self.faults:
            factor *= self._FAULT_FACTORS.get(f, 1.0)
        a = self.expected * factor
        noise = random.gauss(0.0, self.noise_frac * max(self.expected, self.rating * 0.05))
        self.actual = max(0.0, a + noise)
        self.history.append((env["abs_minutes"], self.expected, self.actual))

    def cell_temp(self, env):
        t = env["temp_out"] + 28.0 * env["ghi"]
        if "overheating" in self.faults:
            t += self.OVERHEAT_DELTA_C
        return t

    def performance(self):
        """actual/expected in percent, or None when the panel is dark."""
        if self.expected < 0.05:
            return None
        return round(self.actual / self.expected * 100.0, 1)

    def attributes(self):
        return {"row": self.row, "col": self.col, "quality": round(self.quality, 4)}

    def extra(self, env):
        cell_temp = self.cell_temp(env)
        voltage = 0.0
        if self.actual > 0.01:
            voltage = max(0.0, 33.5 * (1.0 - 0.0035 * (cell_temp - 25.0)))
        current = (self.actual * 1000.0 / voltage) if voltage > 0.5 else 0.0
        return {
            "voltage": round(voltage, 1),
            "current": round(current, 2),
            "cell_temp": round(cell_temp, 1),
            "performance": self.performance(),
            "row": self.row,
            "col": self.col,
        }


class Inverter(Device):
    """50 kW grid-tie inverter. Converts the array's DC output to AC."""

    kind = "inverter"
    noise_frac = 0.01
    rel_floor = 8.0
    anomaly_thresh = 0.05

    HEALTHY_ETA = 0.97

    def expected_power(self, env):
        return min(env["array_dc"], self.rating) * self.HEALTHY_ETA

    def actual_power(self, env):
        if "offline" in self.faults:
            return 0.0
        dc = env["array_dc"]
        cap = self.rating * (0.70 if "derate" in self.faults else 1.0)
        eta = 0.89 if "eff_drop" in self.faults else self.HEALTHY_ETA
        a = min(dc, cap) * eta
        noise = random.gauss(0.0, self.noise_frac * max(a, self.rating * 0.05))
        return max(0.0, a + noise)

    def extra(self, env):
        dc = env["array_dc"]
        eta = (self.actual / dc) if dc > 2.0 else None
        return {
            "dc_in": round(dc, 1),
            "efficiency": round(eta, 3) if eta is not None else None,
        }

    def attributes(self):
        return {"topology": "grid-tie", "rated_kw": self.rating}


class Hvac(Device):
    """3x 12 kW rooftop AC units serving the building."""

    kind = "hvac"
    noise_frac = 0.05
    rel_floor = 6.0
    anomaly_thresh = 0.10

    UNIT_KW = 12.0

    def _duty(self, env):
        demand = max(0.0, (env["temp_out"] - 23.0) * 4.5)
        return clamp(demand / self.rating, 0.0, 1.0)

    def expected_power(self, env):
        return self._duty(env) * self.rating

    def fault_factor(self, env):
        """Multiplier applied to every FCU leaf (see SolarArray.fault_factor)."""
        f = 1.0
        if "overconsumption" in self.faults:
            f *= 1.45
        if "unit_outage" in self.faults:
            f *= 2.0 / 3.0
        if "short_cycle" in self.faults and self.expected > 0.1:
            f += math.sin(env["abs_minutes"] * 0.55) * 0.30 * self.rating / self.expected
        return max(f, 0.0)

    def actual_power(self, env):
        e = self.expected_power(env)
        if "overconsumption" in self.faults:
            e *= 1.45
        if "short_cycle" in self.faults:
            # Rapid compressor cycling: large oscillation around the duty point.
            e += math.sin(env["abs_minutes"] * 0.55) * 0.30 * self.rating
        noise = random.gauss(0.0, self.noise_frac * max(e, self.rating * 0.05))
        return max(0.0, e + noise)

    def extra(self, env):
        return {
            "duty": round(self._duty(env), 2),
            "units_online": 2 if "unit_outage" in self.faults else 3,
        }

    def attributes(self):
        return {"units": 3, "unit_kw": self.UNIT_KW}


class Lighting(Device):
    """6 kW interior lighting, scheduled with daylight-harvesting dimming."""

    kind = "lighting"
    noise_frac = 0.02
    rel_floor = 1.0
    anomaly_thresh = 0.08

    def expected_power(self, env):
        hour = env["hour"]
        if hour < 7.0 or hour >= 19.0:
            return 0.05  # standby
        dim = 0.55 if 10.0 <= hour < 16.0 else 1.0
        return self.rating * dim

    def fault_factor(self, env):
        """Multiplier applied to every room-lighting leaf."""
        hour = env["hour"]
        night = hour < 7.0 or hour >= 19.0
        if "always_on" in self.faults or ("night_on" in self.faults and night):
            return self.rating / max(self.expected, 0.05)
        return 1.0

    def actual_power(self, env):
        hour = env["hour"]
        night = hour < 7.0 or hour >= 19.0
        if ("always_on" in self.faults) or ("night_on" in self.faults and night):
            base = self.rating
        else:
            base = self.expected_power(env)
        noise = random.gauss(0.0, self.noise_frac * max(base, 0.5))
        return max(0.0, base + noise)

    def extra(self, env):
        hour = env["hour"]
        return {"dimming": 0.55 if 10.0 <= hour < 16.0 else 1.0}


class PlugLoads(Device):
    """9 kW office plug loads following an occupancy curve."""

    kind = "plugs"
    noise_frac = 0.04
    rel_floor = 2.0
    anomaly_thresh = 0.10

    def _occupancy(self, hour):
        if 8.0 <= hour < 18.0:
            return 0.95
        if 18.0 <= hour < 21.0:
            return 0.35
        return 0.15

    def expected_power(self, env):
        return self.rating * self._occupancy(env["hour"])

    def fault_factor(self, env):
        """Multiplier applied to every room-plugs leaf."""
        hour = env["hour"]
        if "vampire" in self.faults and (hour < 7.0 or hour >= 19.0):
            return 1.0 + 3.5 / max(self.expected, 0.5)
        return 1.0

    def actual_power(self, env):
        e = self.expected_power(env)
        hour = env["hour"]
        if "vampire" in self.faults and (hour < 7.0 or hour >= 19.0):
            e += 3.5
        noise = random.gauss(0.0, self.noise_frac * max(e, 1.0))
        return max(0.0, e + noise)

    def extra(self, env):
        return {"occupancy": self._occupancy(env["hour"])}


# ---------------- Building hierarchy ----------------

class RoomInfo:
    """A room inside a floor: identity, usage and its leaf devices."""

    def __init__(self, room_id, name, area, usage):
        self.id = room_id
        self.name = name
        self.area = area
        self.usage = usage
        self.device_ids = []


class FloorInfo:
    """A floor of a building: rooms plus the FCU serving it."""

    def __init__(self, floor_id, name, level):
        self.id = floor_id
        self.name = name
        self.level = level
        self.rooms = []
        self.fcu_id = None


class BuildingInfo:
    """A building: floors, its own equipment and whether it hosts the PV roof."""

    def __init__(self, building_id, name, solar):
        self.id = building_id
        self.name = name
        self.solar = solar
        self.floors = []
        self.equipment_ids = []


# (building_id, name, has_rooftop_solar, fcu_kw_per_floor, floor_defs, equipment)
# Room tuples: (room_id, name, area_m2, usage).
# Leaf ratings: lighting 6 kW and plugs 9 kW split area-weighted across every
# room; FCUs split the 36 kW HVAC plant; systems leaves sum to the 20 kW
# 'systems' aggregate. Elevator/UPS/EV/WH have their own daily models.
BUILDING_LAYOUT = [
    {
        "id": "b1",
        "name": "Tower A",
        "solar": True,
        "fcu_kw": 8.0,
        "floors": [
            ("b1f1", "Floor 1", [
                ("b1f1r1", "Lobby", 96, "lobby"),
                ("b1f1r2", "Open Office 1", 84, "office"),
                ("b1f1r3", "Meeting Room", 42, "meeting"),
                ("b1f1r4", "Restrooms", 30, "services"),
            ]),
            ("b1f2", "Floor 2", [
                ("b1f2r1", "Open Office 2", 84, "office"),
                ("b1f2r2", "Server Room", 48, "server"),
                ("b1f2r3", "Meeting Room", 42, "meeting"),
                ("b1f2r4", "Pantry", 30, "services"),
            ]),
            ("b1f3", "Floor 3", [
                ("b1f3r1", "Executive Suite", 72, "office"),
                ("b1f3r2", "Open Office 3", 60, "office"),
                ("b1f3r3", "Meeting Room", 42, "meeting"),
                ("b1f3r4", "Restrooms", 30, "services"),
            ]),
        ],
        "equipment": [
            ("el-b1", "Elevator", "elevator", 8.0),
            ("ups-b1", "Server UPS", "server_ups", 6.0),
            ("ev-b1", "EV Charger", "ev_charger", 4.0),
        ],
    },
    {
        "id": "b2",
        "name": "Annex B",
        "solar": False,
        "fcu_kw": 6.0,
        "floors": [
            ("b2f1", "Floor 1", [
                ("b2f1r1", "Reception", 60, "lobby"),
                ("b2f1r2", "Workshop", 72, "office"),
                ("b2f1r3", "Storage", 36, "services"),
            ]),
            ("b2f2", "Floor 2", [
                ("b2f2r1", "Studio", 72, "office"),
                ("b2f2r2", "Office", 48, "office"),
                ("b2f2r3", "Restrooms", 24, "services"),
            ]),
        ],
        "equipment": [
            ("wh-b2", "Water Heater", "water_heater", 2.0),
        ],
    },
]

SYSTEM_KINDS = {"elevator", "server_ups", "ev_charger", "water_heater"}

# System leaves that live inside a room (so the hierarchy stays physical:
# the UPS is in the server room, the water heater in the storage room).
ROOM_SYSTEM_DEVICES = {"ups-b1": "b1f2r2", "wh-b2": "b2f1r3"}


class RoomLighting(Device):
    """Lighting circuit of one room (a share of the 6 kW lighting plant)."""

    kind = "room_light"
    noise_frac = 0.02
    rel_floor = 0.15
    anomaly_thresh = 0.10

    def __init__(self, dev_id, name, room, share, quality):
        super().__init__(dev_id, name, 6.0 * share)
        self.room_id = room.id
        self.room_name = room.name
        self.share = share
        self.quality = quality

    def step(self, env):
        self.expected = env["lighting_base_kw"] * self.share * self.quality
        e = self.expected
        hour = env["hour"]
        night = hour < 7.0 or hour >= 19.0
        if "always_on" in self.faults or ("night_on" in self.faults and night):
            e = self.rating * self.quality
        noise = random.gauss(0.0, self.noise_frac * max(e, self.rating * 0.05))
        self.actual = max(0.0, e + noise)
        self.history.append((env["abs_minutes"], self.expected, self.actual))

    def extra(self, env):
        hour = env["hour"]
        return {"room": self.room_name,
                "dimming": 0.55 if 10.0 <= hour < 16.0 else 1.0}


class RoomPlugs(Device):
    """Plug loads of one room: computers, monitors and office equipment
    (a share of the 9 kW plug-load plant)."""

    kind = "room_plugs"
    noise_frac = 0.03
    rel_floor = 0.30
    anomaly_thresh = 0.10

    def __init__(self, dev_id, name, room, share, quality):
        super().__init__(dev_id, name, 9.0 * share)
        self.room_id = room.id
        self.room_name = room.name
        self.share = share
        self.quality = quality

    def step(self, env):
        self.expected = env["plugs_base_kw"] * self.share * self.quality
        e = self.expected
        hour = env["hour"]
        if "vampire" in self.faults and (hour < 7.0 or hour >= 19.0):
            e += 3.5 * self.share
        if "overload" in self.faults and 7.0 <= hour < 19.0:
            e *= 1.25
        noise = random.gauss(0.0, self.noise_frac * max(e, self.rating * 0.05))
        self.actual = max(0.0, e + noise)
        self.history.append((env["abs_minutes"], self.expected, self.actual))

    def extra(self, env):
        return {"room": self.room_name, "occupancy": 0.9 if 8.0 <= env["hour"] < 18.0 else 0.15}


class Fcu(Device):
    """Fan-coil unit serving one floor (a share of the 36 kW HVAC plant)."""

    kind = "fcu"
    noise_frac = 0.05
    rel_floor = 1.5
    anomaly_thresh = 0.15  # 3x the noise band; real faults are far beyond

    def __init__(self, dev_id, name, floor_id, rating_kw, plant_kw):
        super().__init__(dev_id, name, rating_kw)
        self.floor_id = floor_id
        self.share = rating_kw / plant_kw

    def step(self, env):
        self.expected = env["fcu_base_kw"] * self.share
        e = self.expected
        if "overconsumption" in self.faults:
            e *= 1.45
        if "unit_outage" in self.faults:
            e = 0.0
        if "short_cycle" in self.faults:
            e += math.sin(env["abs_minutes"] * 0.55) * 0.30 * self.rating
        noise = random.gauss(0.0, self.noise_frac * max(e, self.rating * 0.05))
        self.actual = max(0.0, e + noise)
        self.history.append((env["abs_minutes"], self.expected, self.actual))

    def extra(self, env):
        duty = self.expected / self.rating if self.rating else 0.0
        return {"duty": round(min(duty, 1.0), 2),
                "temp": round(env["temp_out"], 1)}

    def attributes(self):
        return {"plant_share": round(self.share, 4), "serves_floor": self.floor_id}


class Elevator(Device):
    """Traction elevator cycling between the floors during working hours."""

    kind = "elevator"
    noise_frac = 0.04
    rel_floor = 1.0
    anomaly_thresh = 0.10

    def _duty(self, hour):
        if 8.5 <= hour < 9.5:
            return 0.90
        if 12.0 <= hour < 13.0:
            return 0.80
        if 17.0 <= hour < 18.5:
            return 0.85
        if 7.0 <= hour < 19.0:
            return 0.50
        return 0.05

    def expected_power(self, env):
        return self.rating * self._duty(env["hour"])

    def actual_power(self, env):
        e = self.expected_power(env)
        hour = env["hour"]
        night = hour < 7.0 or hour >= 19.0
        if "standby_drift" in self.faults and night:
            e += 1.6
        if "regen_fault" in self.faults and not night:
            e *= 1.18
        noise = random.gauss(0.0, self.noise_frac * max(e, self.rating * 0.05))
        return max(0.0, e + noise)

    def extra(self, env):
        return {"cab_floor": 1 + (env["abs_minutes"] // 40) % 3,
                "duty": round(self._duty(env["hour"]), 2)}

    def attributes(self):
        return {"serves_floors": 3, "drive": "traction"}


class ServerUps(Device):
    """UPS + cooling for the server room, with a nightly battery equalize."""

    kind = "server_ups"
    noise_frac = 0.03
    rel_floor = 1.0
    anomaly_thresh = 0.08

    def expected_power(self, env):
        hour = env["hour"]
        base = 4.6 if 7.0 <= hour < 19.0 else 3.6
        if 20.0 <= hour < 22.0:
            base += 0.8  # battery equalize cycle
        return base

    def actual_power(self, env):
        e = self.expected_power(env)
        if "battery_degraded" in self.faults:
            e += 1.3
        if "cooling_fault" in self.faults and env["temp_out"] > 25.0:
            e *= 1.22
        noise = random.gauss(0.0, self.noise_frac * max(e, 1.0))
        return max(0.0, e + noise)

    def extra(self, env):
        return {"load_pct": round(self.actual / self.rating * 100.0, 0),
                "battery": round(100.0 if "battery_degraded" not in self.faults else 62.0, 0)}

    def attributes(self):
        return {"serves": "server room", "battery_pct": 100 if "battery_degraded" not in self.faults else 62}


class EvCharger(Device):
    """Workplace EV charger with morning / noon / evening charge sessions."""

    kind = "ev_charger"
    noise_frac = 0.03
    rel_floor = 0.8
    anomaly_thresh = 0.10

    def _session(self, hour):
        if 8.0 <= hour < 10.5:
            return 0.90
        if 13.0 <= hour < 15.0:
            return 0.60
        if 18.0 <= hour < 21.0:
            return 0.85
        return 0.05

    def expected_power(self, env):
        return self.rating * self._session(env["hour"])

    def actual_power(self, env):
        e = self.expected_power(env)
        hour = env["hour"]
        night = hour < 7.0 or hour >= 19.0
        if "overconsumption" in self.faults and (night or hour < 8.0):
            e += 3.0
        if "derated" in self.faults and not night:
            e *= 0.55
        noise = random.gauss(0.0, self.noise_frac * max(e, 0.5))
        return max(0.0, e + noise)

    def extra(self, env):
        return {"session": "charging" if self._session(env["hour"]) > 0.5 else "idle"}

    def attributes(self):
        return {"connector": "Type 2", "sessions_per_day": 3}


class WaterHeater(Device):
    """Service water heater with morning and evening draw peaks."""

    kind = "water_heater"
    noise_frac = 0.03
    rel_floor = 0.3
    anomaly_thresh = 0.10

    def _base(self, hour):
        if 6.0 <= hour < 9.0:
            return 1.8
        if 17.0 <= hour < 21.0:
            return 1.5
        return 0.15

    def expected_power(self, env):
        return self._base(env["hour"])

    def actual_power(self, env):
        e = self.expected_power(env)
        if "leak" in self.faults:
            e += 0.9
        if "stuck_element" in self.faults:
            e = max(e, 2.0)
        noise = random.gauss(0.0, self.noise_frac * max(e, 0.5))
        return max(0.0, e + noise)

    def attributes(self):
        return {"tank_l": 120, "fuel": "electric"}

    def extra(self, env):
        tank = 55.0 + 4.0 * (self.actual / 2.0)
        return {"tank_temp": round(tank, 1)}


_EQUIPMENT_CLASSES = {
    "elevator": Elevator,
    "server_ups": ServerUps,
    "ev_charger": EvCharger,
    "water_heater": WaterHeater,
}


# ---------------- Engine ----------------


class SimulationEngine:
    """Owns sim time, weather, devices, history, and the anomaly detector."""

    PANEL_COLS = 12
    PANEL_ROWS = 4

    def __init__(self):
        self.lock = threading.RLock()
        # Monotonic reset counter. Persistence uses it to start a new anomaly
        # epoch even when a reset is followed by a fast catch-up in sim time
        # (a backwards timestamp alone cannot detect every reset).
        self._reset_seq = 0
        self._build_state()

    def _build_state(self):
        """Build the mutable simulation state.

        Called by ``__init__`` and by ``reset()``. It deliberately does not
        touch ``self.lock`` or ``self._reset_seq``: reset must keep the same
        lock object, otherwise a thread that is waiting on the old lock could
        enter the new one while the reset is still mutating state.
        """
        self.day = 1
        self.minutes = int(SUNRISE * 60)  # start at 06:00
        self.speed = 60  # sim-minutes per real second
        self.paused = False
        self.weather = Weather()
        self.devices = [
            SolarArray("solar", "Solar Array", 50.0),
            Inverter("inverter", "Inverter", 50.0),
            Hvac("hvac", "HVAC plant", 36.0),
            Lighting("lighting", "Lighting", 6.0),
            PlugLoads("plugs", "Plug Loads", 9.0),
            Device("systems", "Building Systems", 20.0),
            BatteryStorage(),
        ]
        self._by_id = {d.id: d for d in self.devices}

        # Campus hierarchy: buildings -> floors -> rooms -> leaf devices.
        self.buildings, self.equipment = self._build_buildings()
        self._by_id.update({d.id: d for d in self.equipment})

        # Individual rooftop PV modules. Ratings sum to the array's 50 kWp.
        # Quality factors are deterministic (fixed seed) and normalized so the
        # healthy panels' output sums exactly to the array's expected output.
        rng = random.Random(7)
        raw = [rng.uniform(0.94, 1.06) for _ in range(self.PANEL_COLS * self.PANEL_ROWS)]
        norm = len(raw) / sum(raw)
        self.panels = []
        per_panel = 50.0 / len(raw)
        for i, q in enumerate(raw):
            row, col = divmod(i, self.PANEL_COLS)
            pid = f"p{i + 1:02d}"
            self.panels.append(SolarPanel(pid, f"Panel P-{i + 1:02d}",
                                          row + 1, col + 1, per_panel, q * norm))
        self._by_id.update({p.id: p for p in self.panels})

        # Parent chain for the rooftop equipment (the PV plant lives on b1).
        solar_building = next((b.id for b in self.buildings if b.solar), None)
        for d in self.devices:
            if d.id in ("solar", "inverter"):
                d.building_id = solar_building
        for p in self.panels:
            p.building_id = solar_building

        self.history = deque(maxlen=600)  # global power history
        self.events = deque(maxlen=60)    # anomaly + operator events
        self.last_tick_wall = time.time()  # real time of the last advance
        self.today = {"solar_kwh": 0.0, "load_kwh": 0.0, "import_kwh": 0.0,
                      "export_kwh": 0.0, "storage_charge_kwh": 0.0,
                      "storage_discharge_kwh": 0.0}
        self.yesterday = dict(self.today)
        self._event_seq = 0

        from ai.anomaly import AnomalyDetector
        self.detector = AnomalyDetector()

    def _build_buildings(self):
        """Construct the campus hierarchy and its leaf devices.

        Lighting / plugs / FCU leaves follow the SolarArray/SolarPanel
        pattern: the aggregate device owns the healthy model, each leaf
        simulates a fixed share of it (own faults + noise only) and the
        aggregate's actual reading becomes the sum of its leaves. Systems
        leaves (elevator, UPS, EV charger, water heater) have their own
        daily models and are summed bottom-up into the 'systems' aggregate.
        """
        rng = random.Random(11)
        buildings = []
        equipment = []
        rooms = []  # (building, floor, room) for share computation
        plant_kw = sum(spec["fcu_kw"] * len(spec["floors"]) for spec in BUILDING_LAYOUT)

        for spec in BUILDING_LAYOUT:
            building = BuildingInfo(spec["id"], spec["name"], spec["solar"])
            for level, (floor_id, floor_name, room_defs) in enumerate(spec["floors"], start=1):
                floor = FloorInfo(floor_id, floor_name, level)
                for room_id, room_name, area, usage in room_defs:
                    room = RoomInfo(room_id, room_name, area, usage)
                    floor.rooms.append(room)
                    rooms.append((building, floor, room))
                fcu = Fcu(f"fc-{floor_id}", f"{floor_name} FCU", floor_id,
                          spec["fcu_kw"], plant_kw)
                fcu.building_id = building.id
                fcu.floor_id = floor.id
                floor.fcu_id = fcu.id
                equipment.append(fcu)
                building.floors.append(floor)
            for dev_id, name, kind, kw in spec["equipment"]:
                dev = _EQUIPMENT_CLASSES[kind](dev_id, name, kw)
                dev.building_id = building.id
                building.equipment_ids.append(dev_id)
                equipment.append(dev)
            buildings.append(building)

        # Room lighting and plug leaves: area-weighted shares with quality
        # factors normalized so healthy leaves sum exactly to the aggregate.
        total_area = sum(r.area for _, _, r in rooms)

        def make_leaves(cls, prefix, rating):
            raws = [rng.uniform(0.94, 1.06) for _ in rooms]
            denom = sum((r.area / total_area) * q for (_, _, r), q in zip(rooms, raws))
            for (building, floor, room), raw in zip(rooms, raws):
                dev = cls(f"{prefix}-{room.id}", f"{room.name} {prefix.upper()}",
                          room, room.area / total_area, raw / denom)
                dev.building_id = building.id
                dev.floor_id = floor.id
                dev.room_id = room.id
                room.device_ids.append(dev.id)
                equipment.append(dev)

        make_leaves(RoomLighting, "lt", 6.0)
        make_leaves(RoomPlugs, "pl", 9.0)

        # System leaves that live inside a room get the full parent chain.
        room_ctx = {r.id: (b, f, r) for (b, f, r) in rooms}
        by_id = {d.id: d for d in equipment}
        for dev_id, room_id in ROOM_SYSTEM_DEVICES.items():
            b, f, r = room_ctx[room_id]
            r.device_ids.append(dev_id)
            dev = by_id[dev_id]
            dev.floor_id = f.id
            dev.room_id = r.id
        return buildings, equipment

    # --- time ---

    @property
    def all_devices(self):
        """Every metered object: aggregates, PV modules and building leaves."""
        return list(self.devices) + list(self.panels) + list(self.equipment)

    @property
    def abs_minutes(self):
        return (self.day - 1) * DAY_MINUTES + self.minutes

    @property
    def hour(self):
        return self.minutes / 60.0

    @property
    def time_label(self):
        h = int(self.hour)
        m = int((self.hour - h) * 60)
        return f"{h:02d}:{m:02d}"

    # --- main tick (called once per real second) ---

    def tick(self):
        with self.lock:
            if self.paused:
                return
            self.last_tick_wall = time.time()
            self.minutes += self.speed
            if self.minutes >= DAY_MINUTES:
                self.minutes -= DAY_MINUTES
                self.day += 1
                self.yesterday = dict(self.today)
                self.today = {"solar_kwh": 0.0, "load_kwh": 0.0, "import_kwh": 0.0,
                      "export_kwh": 0.0, "storage_charge_kwh": 0.0,
                      "storage_discharge_kwh": 0.0}
                for dev in self.all_devices:
                    dev.reset_daily_energy()

            self.weather.step(self.speed)
            hour = self.hour
            env = {
                "abs_minutes": self.abs_minutes,
                "hour": hour,
                "temp_out": self.weather.temp_out(hour),
                "cloud": self.weather.cloud,
                "ghi": self.weather.daylight(hour) * (1.0 - 0.65 * self.weather.cloud),
                "array_dc": 0.0,
            }

            solar, inverter, hvac, lighting, plugs, systems = self.devices[:6]
            solar.step(env)
            # Panel-level simulation: every module steps against its share of
            # the array's expected output (array-level faults included), then
            # the array's actual reading becomes the sum of the modules.
            env["panel_base_kw"] = (solar.expected / len(self.panels)) * solar.fault_factor()
            for panel in self.panels:
                panel.step(env)
            for panel in self.panels:
                panel.apply_sensor_faults()
            solar.actual = sum(p.actual for p in self.panels)
            env["array_dc"] = solar.actual
            inverter.step(env)
            hvac.step(env)
            lighting.step(env)
            plugs.step(env)

            # Leaf-level simulation (see _build_buildings): the healthy
            # aggregate model (faults included) is shared out to the leaves,
            # then the aggregate's actual reading becomes the sum of leaves.
            env["fcu_base_kw"] = hvac.expected * hvac.fault_factor(env)
            env["lighting_base_kw"] = lighting.expected * lighting.fault_factor(env)
            env["plugs_base_kw"] = plugs.expected * plugs.fault_factor(env)
            for dev in self.equipment:
                dev.step(env)
            for dev in self.equipment:
                dev.apply_sensor_faults()
            hvac.actual = sum(d.actual for d in self.equipment if d.kind == "fcu")
            lighting.actual = sum(d.actual for d in self.equipment if d.kind == "room_light")
            plugs.actual = sum(d.actual for d in self.equipment if d.kind == "room_plugs")
            systems.expected = sum(d.expected for d in self.equipment if d.kind in SYSTEM_KINDS)
            systems.actual = sum(d.actual for d in self.equipment if d.kind in SYSTEM_KINDS)
            systems.history.append((env["abs_minutes"], systems.expected, systems.actual))

            # Sensor-layer faults applied to an aggregate distort that
            # aggregate's own reported measurement after its honest sum has
            # been formed. (Leaves were handled above; the battery is a signed
            # flow and is handled after its step below.)
            for dev in self.devices[:6]:
                dev.apply_sensor_faults()

            total_load = hvac.actual + lighting.actual + plugs.actual + systems.actual
            grid_net = total_load - inverter.actual
            dt_h = self.speed / 60.0

            # Battery storage follows the net PV flow; its signed power
            # (+ charging / − discharging) is reported separately from the
            # PV-vs-load grid exchange so existing semantics stay intact.
            battery = self.devices[6] if len(self.devices) > 6 else None
            if battery is not None:
                battery.step(env, inverter.actual - total_load, dt_h)
                battery.apply_sensor_faults()
                storage_kw = battery.actual
                self.today["storage_charge_kwh"] += max(0.0, storage_kw) * dt_h
                self.today["storage_discharge_kwh"] += max(0.0, -storage_kw) * dt_h

            self.today["solar_kwh"] += inverter.actual * dt_h
            self.today["load_kwh"] += total_load * dt_h
            if grid_net > 0:
                self.today["import_kwh"] += grid_net * dt_h
            else:
                self.today["export_kwh"] += -grid_net * dt_h

            # Per-equipment metering: energy today + cumulative operating hours.
            for dev in self.all_devices:
                dev.account(dt_h, env["abs_minutes"])

            self.history.append({
                "t": self.abs_minutes,
                "solar": round(inverter.actual, 1),
                "load": round(total_load, 1),
                "grid": round(grid_net, 1),
                "temp": round(env["temp_out"], 1),
                "cloud": round(self.weather.cloud, 2),
            })

            self.detector.update(self, env)

    # --- controls ---

    def set_speed(self, speed):
        with self.lock:
            self.speed = clamp(int(speed), 1, 1440)

    def set_paused(self, paused):
        with self.lock:
            self.paused = bool(paused)

    def set_weather(self, mode):
        with self.lock:
            if mode in ("auto", "clear", "partly", "cloudy", "overcast"):
                self.weather.mode = mode

    def set_fault(self, device_id, fault_id, active):
        with self.lock:
            dev = self._by_id.get(device_id)
            if dev is None:
                return False
            catalog = {f["id"]: f for f in faults_for(dev.kind)}
            if fault_id not in catalog:
                return False
            dev.set_fault(fault_id, active)
            verb = "Injected" if active else "Cleared"
            self._add_event("operator", dev.id, dev.name,
                            f"{verb} virtual fault: {catalog[fault_id]['name']}")
            return True

    def reset(self):
        """Full reset: back to day 1 06:00, no faults, no events.

        Rebuilds the state under the existing lock instead of re-running
        ``__init__``: replacing the lock object mid-reset would let another
        thread acquire the new lock while this one is still re-initialising,
        exposing a partially reset engine.
        """
        with self.lock:
            self._reset_seq += 1
            self._build_state()

    def _add_event(self, severity, device_id, device_name, message, active=True):
        self._event_seq += 1
        event = {
            "id": self._event_seq,
            "ts": self.abs_minutes,
            "day": self.day,
            "time": self.time_label,
            "device_id": device_id,
            "device_name": device_name,
            "severity": severity,
            "message": message,
            "active": active,
        }
        self.events.appendleft(event)
        return event

    # --- snapshot for the API ---

    def _device_snap(self, d, env, nd=1):
        """Shared serialization for aggregate devices, panels and leaves.

        Carries the full equipment data model: stable id, name, category,
        parent chain, rated power, status, operating hours, energy today,
        measurement timestamp, source, optional sensor readings and
        equipment-specific attributes.
        """
        e = d.expected
        a = d.actual
        rel = (a - e) / max(e, d.rel_floor) if e > 0 or a > 0 else 0.0
        return {
            "id": d.id,
            "name": d.name,
            "kind": d.kind,
            "rating": round(d.rating, 3 if nd > 1 else 1),
            "actual": round(a, nd),
            "expected": round(e, nd),
            "rel": round(rel, 3),
            "status": self.detector.device_status(d.id),
            "faults": [{"id": f["id"], "name": f["name"],
                        "layer": f.get("layer", "equipment")}
                       for f in faults_for(d.kind) if f["id"] in d.faults],
            "extra": d.extra(env),
            # --- equipment data model ---
            "source": d.source,
            "parent": {"building": d.building_id, "floor": d.floor_id, "room": d.room_id},
            "energy_today_kwh": round(d.energy_today_kwh, 3),
            "operating_hours": round(d.operating_hours, 2),
            "measured_at": {"abs_minutes": env["abs_minutes"],
                            "day": self.day, "time": self.time_label},
            "attributes": d.attributes(),
        }

    def _active_anomalies(self, device_ids):
        ids = set(device_ids)
        return len([e for e in self.events
                    if e["active"] and e["severity"] != "operator"
                    and e["device_id"] in ids])

    def snapshot(self, full_anomalies=False):
        """Serialized state for the API.

        ``snapshot["anomalies"]`` is capped at the 10 highest-priority active
        events for the dashboard. Persistence and alarm syncs pass
        ``full_anomalies=True`` so an event outside that window is not
        mistaken for recovery and closed while it is still live.
        """
        with self.lock:
            env = {
                "abs_minutes": self.abs_minutes,
                "hour": self.hour,
                "temp_out": self.weather.temp_out(self.hour),
                "cloud": self.weather.cloud,
                "ghi": self.weather.daylight(self.hour) * (1.0 - 0.65 * self.weather.cloud),
                "array_dc": self.devices[0].actual,
            }
            devices = [self._device_snap(d, env) for d in self.devices]
            panels = []
            for p in self.panels:
                snap = self._device_snap(p, env, nd=2)
                snap["row"] = p.row
                snap["col"] = p.col
                panels.append(snap)
            equipment = [self._device_snap(d, env, nd=2) for d in self.equipment]
            equip_by_id = {s["id"]: s for s in equipment}

            buildings = []
            for b in self.buildings:
                floors = []
                for f in b.floors:
                    rooms = []
                    for r in f.rooms:
                        rdevs = [equip_by_id[i] for i in r.device_ids]
                        rooms.append({
                            "id": r.id,
                            "name": r.name,
                            "usage": r.usage,
                            "area": r.area,
                            "devices": rdevs,
                            "actual": round(sum(d["actual"] for d in rdevs), 2),
                            "expected": round(sum(d["expected"] for d in rdevs), 2),
                            # energy is the sum of this room's own devices only
                            "energy_today_kwh": round(sum(d["energy_today_kwh"] for d in rdevs), 3),
                            "anomalies": self._active_anomalies(r.device_ids),
                        })
                    fdev_ids = [d for r in rooms for d in [x["id"] for x in r["devices"]]] + [f.fcu_id]
                    fcu = equip_by_id.get(f.fcu_id)
                    fcu_a = fcu["actual"] if fcu else 0.0
                    fcu_e = fcu["expected"] if fcu else 0.0
                    fcu_kwh = fcu["energy_today_kwh"] if fcu else 0.0
                    floors.append({
                        "id": f.id,
                        "name": f.name,
                        "level": f.level,
                        "rooms": rooms,
                        "fcu": fcu,
                        "area": sum(x["area"] for x in rooms),
                        "actual": round(sum(x["actual"] for x in rooms) + fcu_a, 2),
                        "expected": round(sum(x["expected"] for x in rooms) + fcu_e, 2),
                        "energy_today_kwh": round(
                            sum(x["energy_today_kwh"] for x in rooms) + fcu_kwh, 3),
                        "anomalies": self._active_anomalies(fdev_ids),
                    })
                bdevs = [equip_by_id[i] for i in b.equipment_ids]
                roof_ids = (["solar", "inverter"] + [p["id"] for p in panels]) if b.solar else []
                # Units are in exactly one place in the tree (a room, a floor
                # or the building itself), so sum the *unique* set of device
                # ids to avoid counting room-hosted system leaves twice.
                consumption_ids = set()
                for x in floors:
                    consumption_ids.update(d["id"] for r in x["rooms"] for d in r["devices"])
                    consumption_ids.add(x["fcu"]["id"])
                consumption_ids.update(b.equipment_ids)
                buildings.append({
                    "id": b.id,
                    "name": b.name,
                    "solar": b.solar,
                    "floors": floors,
                    "equipment": bdevs,
                    "roof_device_ids": roof_ids,
                    "area": sum(x["area"] for x in floors),
                    "actual": round(sum(equip_by_id[i]["actual"] for i in consumption_ids), 2),
                    "expected": round(sum(equip_by_id[i]["expected"] for i in consumption_ids), 2),
                    # energy: unique devices only - the same rule as actual/expected
                    "energy_today_kwh": round(
                        sum(equip_by_id[i]["energy_today_kwh"] for i in consumption_ids), 3),
                    "anomalies": self._active_anomalies(list(consumption_ids) + roof_ids),
                })

            hvac, lighting, plugs, systems = (self.devices[2], self.devices[3],
                                              self.devices[4], self.devices[5])
            total_load = hvac.actual + lighting.actual + plugs.actual + systems.actual
            net = total_load - self.devices[1].actual
            sufficiency = (self.devices[1].actual / total_load) if total_load > 1 else 1.0
            battery = self.devices[6] if len(self.devices) > 6 else None
            return {
                "sim": {
                    "day": self.day,
                    "time": self.time_label,
                    "minutes": self.minutes,
                    "speed": self.speed,
                    "paused": self.paused,
                    "weather": self.weather.mode,
                    "cloud": round(self.weather.cloud, 2),
                    "temp_out": round(env["temp_out"], 1),
                    "sun": round(self.weather.daylight(self.hour), 2),
                    "reset_seq": self._reset_seq,
                },
                "kpis": {
                    "solar_kw": round(self.devices[1].actual, 1),
                    "load_kw": round(total_load, 1),
                    "net_kw": round(net, 1),
                    "sufficiency": round(sufficiency, 2),
                    "storage_kw": round(battery.actual, 1) if battery else 0.0,
                    "soc_pct": round(100.0 * battery.soc_kwh / battery.capacity_kwh, 0) if battery else None,
                    "today": {k: round(v, 1) for k, v in self.today.items()},
                    "yesterday": {k: round(v, 1) for k, v in self.yesterday.items()},
                    "anomalies": len([e for e in self.events if e["active"] and e["severity"] != "operator"]),
                },
                "devices": devices,
                "panels": panels,
                "equipment": equipment,
                "buildings": buildings,
                "grid": {
                    "net_kw": round(net, 1),
                    "import_kw": round(max(net, 0.0), 1),
                    "export_kw": round(max(-net, 0.0), 1),
                },
                "anomalies": ([e for e in self.events
                               if e["active"] and e["severity"] != "operator"]
                              if full_anomalies else
                              [e for e in self.events
                               if e["active"] and e["severity"] != "operator"][:10]),
                "events": list(self.events)[:30],
                "history": list(self.history),
            }

    def history_series(self, include_panels=False):
        """Raw per-device (timestamp_minutes, actual_kw) series.

        Acquired under the engine lock in one pass, for historical playback.
        Deliberately does not call ``snapshot()`` while holding the lock
        (``self.lock`` is not re-entrant); callers combine this mapping with a
        separately acquired snapshot.
        """
        with self.lock:
            if include_panels:
                devices = self.all_devices
            else:
                devices = list(self.devices) + list(self.equipment)
            return {
                dev.id: [(t, round(actual, 6)) for t, _expected, actual in dev.history]
                for dev in devices
            }

    def device_detail(self, device_id):
        """Snapshot for one device: catalog, history, active anomaly."""
        with self.lock:
            dev = self._by_id.get(device_id)
            if dev is None:
                return None
            env = {
                "abs_minutes": self.abs_minutes,
                "hour": self.hour,
                "temp_out": self.weather.temp_out(self.hour),
                "cloud": self.weather.cloud,
                "ghi": self.weather.daylight(self.hour) * (1.0 - 0.65 * self.weather.cloud),
                "array_dc": self.devices[0].actual,
            }
            catalog = faults_for(dev.kind)
            active_anomaly = next(
                (e for e in self.events
                 if e["active"] and e["severity"] != "operator" and e["device_id"] == device_id),
                None,
            )
            detail = {
                "id": dev.id,
                "name": dev.name,
                "kind": dev.kind,
                "rating": dev.rating,
                "actual": round(dev.actual, 1),
                "expected": round(dev.expected, 1),
                "status": self.detector.device_status(dev.id),
                "extra": dev.extra(env),
                # equipment data model
                "source": dev.source,
                "parent": {"building": dev.building_id, "floor": dev.floor_id,
                           "room": dev.room_id},
                "energy_today_kwh": round(dev.energy_today_kwh, 3),
                "operating_hours": round(dev.operating_hours, 2),
                "measured_at": {"abs_minutes": self.abs_minutes,
                                "day": self.day, "time": self.time_label},
                "attributes": dev.attributes(),
                "faults": [
                    {"id": f["id"], "name": f["name"], "description": f["description"],
                     "severity": f["severity"], "layer": f.get("layer", "equipment"),
                     "active": f["id"] in dev.faults}
                    for f in catalog
                ],
                "anomaly": active_anomaly,
                # Copied while the lock is held: iterating the live deque from
                # an HTTP thread can race with a tick's appendleft.
                "alerts": [
                    e for e in self.events
                    if e.get("device_id") == device_id
                    and e.get("severity") != "operator"
                ][:8],
                "history": [
                    {"t": t, "expected": round(e, 1), "actual": round(a, 1)}
                    for t, e, a in dev.history
                ],
            }
            if dev.kind == "panel":
                detail["panel"] = {
                    "row": dev.row,
                    "col": dev.col,
                    "rows": self.PANEL_ROWS,
                    "cols": self.PANEL_COLS,
                    "performance": dev.performance(),
                }
            return detail
