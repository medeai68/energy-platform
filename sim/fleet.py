"""Phase 6 — fleet dataset feeder (imported source).

A small, deterministic "imported dataset" for two external sites, registered
through the same ``sync_registry`` path as the simulated campus and sampled
through the same ``import_measurement`` canonical UPSERT. Every value is
generated from a fixed seed — it is simulated data labelled as an imported
dataset feed, never real hardware.

Timestamps use the wall clock so samples keep arriving while the campus
simulation is paused; the canonical (equipment, measured_at) key makes
repeated imports idempotent.
"""

import random
import time

SITE_A = {
    "id": "ext-a",
    "name": "Warehouse 12",
    "source": "imported",
    "devices": [
        {"id": "ext-a-chiller", "name": "Chiller 1", "kind": "hvac",
         "rating": 45.0, "base": 26.0, "amp": 14.0},
        {"id": "ext-a-lighting", "name": "Warehouse lighting", "kind": "lighting",
         "rating": 8.0, "base": 3.2, "amp": 4.8},
        {"id": "ext-a-conveyors", "name": "Conveyor lines", "kind": "plugs",
         "rating": 12.0, "base": 6.0, "amp": 6.0},
        {"id": "ext-a-heater", "name": "Water heater", "kind": "water_heater",
         "rating": 4.0, "base": 1.4, "amp": 2.2},
        {"id": "ext-a-lift", "name": "Freight lift", "kind": "elevator",
         "rating": 6.0, "base": 1.8, "amp": 3.6},
    ],
}

SITE_B = {
    "id": "ext-b",
    "name": "Office 3",
    "source": "live",
    "devices": [
        {"id": "ext-b-fcu", "name": "FCU plant", "kind": "fcu",
         "rating": 18.0, "base": 8.0, "amp": 9.0},
        {"id": "ext-b-lighting", "name": "Office lighting", "kind": "room_light",
         "rating": 3.0, "base": 1.0, "amp": 1.8},
        {"id": "ext-b-plugs", "name": "Workstation plugs", "kind": "room_plug",
         "rating": 5.0, "base": 2.4, "amp": 2.2},
        {"id": "ext-b-ups", "name": "Server UPS", "kind": "server_ups",
         "rating": 8.0, "base": 4.6, "amp": 1.2},
    ],
}


class FleetDataset:
    """Deterministic imported-dataset feed for the external sites.

    Uses the wall clock for timestamps (independent of the paused campus
    simulation) and a fixed per-device seed so every run replays the same
    series shape with a small amount of noise."""

    def __init__(self, seed=11):
        self.rngs = {}
        for site in (SITE_A, SITE_B):
            for d in site["devices"]:
                r = random.Random(f"{seed}:{d['id']}")
                self.rngs[d["id"]] = r

    @staticmethod
    def sites():
        return [SITE_A, SITE_B]

    def ensure_registered(self, store):
        """Register the external equipment through the canonical registry
        path (no schema or store changes)."""
        devices = []
        equipment = []
        buildings = []
        for site in (SITE_A, SITE_B):
            site_eq = []
            for d in site["devices"]:
                item = {
                    "id": d["id"],
                    "name": d["name"],
                    "kind": d["kind"],
                    "rating": d["rating"],
                    "source": site["source"],
                    "parent": {"building": site["id"]},
                    "attributes": {"fleet_site": site["name"]},
                }
                equipment.append(item)
                site_eq.append(item)
            buildings.append({
                "id": site["id"],
                "name": site["name"],
                "floors": [],
                "solar": False,
                "equipment_ids": [x["id"] for x in site_eq],
                "roof_device_ids": [],
            })
        # _all_devices walks devices + panels + equipment; the external
        # equipment are leaves (equipment list).
        store.sync_registry({
            "devices": devices,
            "panels": [],
            "equipment": equipment,
            "buildings": buildings,
        })

    def feed_once(self, store):
        """Import one sample per IMPORTED-site device (wall-clock
        timestamp). The live site (ext-b) is fed by the simulated MQTT
        adapter instead."""
        now = time.time()
        hour = time.localtime(now).tm_hour
        # daytime factor: workday curve 06..20, dip at lunch
        dayf = 1.0 if 6 <= hour <= 20 else 0.25
        for site in (SITE_A,):
            for d in site["devices"]:
                r = self.rngs[d["id"]]
                actual = d["base"] + d["amp"] * dayf * (0.85 + 0.3 * r.random())
                expected = d["base"] + d["amp"] * dayf
                store.import_measurement(
                    equipment_id=d["id"],
                    measured_at=int(now),
                    measured_day=int(time.strftime("%j", time.localtime(now))),
                    measured_time=time.strftime("%H:%M", time.localtime(now)),
                    actual_kw=round(actual, 2),
                    expected_kw=round(expected, 2),
                    status="ok",
                    source="imported",
                    sensors={"feed": "simulated imported dataset"},
                )
