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
        else:
            self.faults.discard(fault_id)

    # --- API serialization ---

    def status(self):
        return "ok"  # overridden by detector via device_state

    def extra(self, env):
        return {}


class SolarArray(Device):
    """50 kWp rooftop array. Output follows irradiance with temperature derating."""

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

    def apply_faults(self, e, env):
        factor = 1.0
        for f in self.faults:
            factor *= self._FAULT_FACTORS.get(f, 1.0)
        return e * factor

    def extra(self, env):
        return {
            "ghi": round(env["ghi"], 2),
            "cell_temp": round(env["temp_out"] + 28.0 * env["ghi"], 1),
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
        units = 2 if "unit_outage" in self.faults else 3
        return self._duty(env) * units * self.UNIT_KW

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

    def actual_power(self, env):
        e = self.expected_power(env)
        hour = env["hour"]
        if "vampire" in self.faults and (hour < 7.0 or hour >= 19.0):
            e += 3.5
        noise = random.gauss(0.0, self.noise_frac * max(e, 1.0))
        return max(0.0, e + noise)

    def extra(self, env):
        return {"occupancy": self._occupancy(env["hour"])}


# ---------------- Engine ----------------


class SimulationEngine:
    """Owns sim time, weather, devices, history, and the anomaly detector."""

    def __init__(self):
        self.lock = threading.RLock()
        self.day = 1
        self.minutes = int(SUNRISE * 60)  # start at 06:00
        self.speed = 60  # sim-minutes per real second
        self.paused = False
        self.weather = Weather()
        self.devices = [
            SolarArray("solar", "Solar Array", 50.0),
            Inverter("inverter", "Inverter", 50.0),
            Hvac("hvac", "HVAC (3 units)", 36.0),
            Lighting("lighting", "Lighting", 6.0),
            PlugLoads("plugs", "Plug Loads", 9.0),
        ]
        self._by_id = {d.id: d for d in self.devices}
        self.history = deque(maxlen=600)  # global power history
        self.events = deque(maxlen=60)    # anomaly + operator events
        self.today = {"solar_kwh": 0.0, "load_kwh": 0.0, "import_kwh": 0.0, "export_kwh": 0.0}
        self.yesterday = dict(self.today)
        self._event_seq = 0

        from ai.anomaly import AnomalyDetector
        self.detector = AnomalyDetector()

    # --- time ---

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
            self.minutes += self.speed
            if self.minutes >= DAY_MINUTES:
                self.minutes -= DAY_MINUTES
                self.day += 1
                self.yesterday = dict(self.today)
                self.today = {"solar_kwh": 0.0, "load_kwh": 0.0, "import_kwh": 0.0, "export_kwh": 0.0}

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

            solar, inverter, hvac, lighting, plugs = self.devices
            solar.step(env)
            env["array_dc"] = solar.actual
            inverter.step(env)
            hvac.step(env)
            lighting.step(env)
            plugs.step(env)

            total_load = hvac.actual + lighting.actual + plugs.actual
            grid_net = total_load - inverter.actual
            dt_h = self.speed / 60.0

            self.today["solar_kwh"] += inverter.actual * dt_h
            self.today["load_kwh"] += total_load * dt_h
            if grid_net > 0:
                self.today["import_kwh"] += grid_net * dt_h
            else:
                self.today["export_kwh"] += -grid_net * dt_h

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
        """Full reset: back to day 1 06:00, no faults, no events."""
        with self.lock:
            self.__init__()

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

    def snapshot(self):
        with self.lock:
            env = {
                "abs_minutes": self.abs_minutes,
                "hour": self.hour,
                "temp_out": self.weather.temp_out(self.hour),
                "cloud": self.weather.cloud,
                "ghi": self.weather.daylight(self.hour) * (1.0 - 0.65 * self.weather.cloud),
                "array_dc": self.devices[0].actual,
            }
            devices = []
            for d in self.devices:
                e = d.expected
                a = d.actual
                rel = (a - e) / max(e, d.rel_floor) if e > 0 or a > 0 else 0.0
                devices.append({
                    "id": d.id,
                    "name": d.name,
                    "kind": d.kind,
                    "rating": d.rating,
                    "actual": round(a, 1),
                    "expected": round(e, 1),
                    "rel": round(rel, 3),
                    "status": self.detector.device_status(d.id),
                    "faults": [{"id": f["id"], "name": f["name"]} for f in faults_for(d.kind) if f["id"] in d.faults],
                    "extra": d.extra(env),
                })
            hvac, lighting, plugs = self.devices[2], self.devices[3], self.devices[4]
            total_load = hvac.actual + lighting.actual + plugs.actual
            net = total_load - self.devices[1].actual
            sufficiency = (self.devices[1].actual / total_load) if total_load > 1 else 1.0
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
                },
                "kpis": {
                    "solar_kw": round(self.devices[1].actual, 1),
                    "load_kw": round(total_load, 1),
                    "net_kw": round(net, 1),
                    "sufficiency": round(sufficiency, 2),
                    "today": {k: round(v, 1) for k, v in self.today.items()},
                    "yesterday": {k: round(v, 1) for k, v in self.yesterday.items()},
                    "anomalies": len([e for e in self.events if e["active"] and e["severity"] != "operator"]),
                },
                "devices": devices,
                "grid": {
                    "net_kw": round(net, 1),
                    "import_kw": round(max(net, 0.0), 1),
                    "export_kw": round(max(-net, 0.0), 1),
                },
                "anomalies": [e for e in self.events if e["active"] and e["severity"] != "operator"][:10],
                "events": list(self.events)[:30],
                "history": list(self.history),
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
            return {
                "id": dev.id,
                "name": dev.name,
                "kind": dev.kind,
                "rating": dev.rating,
                "actual": round(dev.actual, 1),
                "expected": round(dev.expected, 1),
                "status": self.detector.device_status(dev.id),
                "extra": dev.extra(env),
                "faults": [
                    {"id": f["id"], "name": f["name"], "description": f["description"],
                     "severity": f["severity"], "active": f["id"] in dev.faults}
                    for f in catalog
                ],
                "anomaly": active_anomaly,
                "history": [
                    {"t": t, "expected": round(e, 1), "actual": round(a, 1)}
                    for t, e, a in dev.history
                ],
            }
