"""Canonical equipment data model.

Every metered object in the platform - aggregate plant, PV module, room
circuit, fan-coil, elevator, ... - is described by the same fields:

    id                  stable equipment id (primary key, never reused)
    name                human-readable name
    category            equipment category (device kind)
    building_id         parent building id    (nullable for campus-level plant)
    floor_id            parent floor id       (nullable)
    room_id             parent room id        (nullable)
    rated_kw            nameplate power in kW
    source              live | imported | simulated

and, per measurement (one canonical row per equipment and timestamp):

    measured_at         canonical measurement time: sim absolute minutes for
                        simulated equipment, wall-clock Unix seconds for
                        live/imported feeds
    measured_day/time   human-readable timestamp for the same clock
    actual_kw           measured power
    expected_kw         healthy-model expectation
    energy_today_kwh    energy accumulated since sim midnight
    operating_hours     cumulative runtime hours
    status              ok | warning | serious | critical
    sensors             optional sensor readings (JSON object)
    attributes          equipment-specific static fields (JSON object)

Anomalies are separate records keyed by (equipment_id, event_key) so an open
anomaly is updated in place rather than duplicated.
"""

from __future__ import annotations

from dataclasses import dataclass, field

SOURCES = ("live", "imported", "simulated")
STATUSES = ("ok", "warning", "serious", "critical")

CATEGORY_LABELS = {
    "solar": "PV array",
    "inverter": "Inverter",
    "hvac": "HVAC plant",
    "lighting": "Lighting plant",
    "plugs": "Plug loads",
    "systems": "Building systems",
    "panel": "PV module",
    "room_light": "Room lighting",
    "room_plugs": "Room plug loads",
    "fcu": "Fan-coil unit",
    "elevator": "Elevator",
    "server_ups": "Server UPS",
    "ev_charger": "EV charger",
    "water_heater": "Water heater",
    "battery_storage": "Battery storage",}


@dataclass
class Equipment:
    id: str
    name: str
    category: str
    building_id: str | None = None
    floor_id: str | None = None
    room_id: str | None = None
    rated_kw: float = 0.0
    source: str = "simulated"
    attributes: dict = field(default_factory=dict)

    def __post_init__(self):
        if self.source not in SOURCES:
            raise ValueError(f"invalid data source {self.source!r}")
        if not self.id:
            raise ValueError("equipment id is required")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "category_label": CATEGORY_LABELS.get(self.category, self.category),
            "parent": {"building": self.building_id,
                       "floor": self.floor_id,
                       "room": self.room_id},
            "rated_kw": self.rated_kw,
            "source": self.source,
            "attributes": self.attributes,
        }


@dataclass
class Measurement:
    equipment_id: str
    measured_at: int
    measured_day: int
    measured_time: str
    actual_kw: float | None
    expected_kw: float | None
    energy_today_kwh: float
    operating_hours: float
    status: str
    source: str
    sensors: dict = field(default_factory=dict)

    def __post_init__(self):
        if self.status not in STATUSES:
            raise ValueError(f"invalid status {self.status!r}")
        if self.source not in SOURCES:
            raise ValueError(f"invalid data source {self.source!r}")

    def to_dict(self):
        return {
            "equipment_id": self.equipment_id,
            "measured_at": self.measured_at,
            "measured_day": self.measured_day,
            "measured_time": self.measured_time,
            "actual_kw": self.actual_kw,
            "expected_kw": self.expected_kw,
            "energy_today_kwh": self.energy_today_kwh,
            "operating_hours": self.operating_hours,
            "status": self.status,
            "source": self.source,
            "sensors": self.sensors,
        }


@dataclass
class Anomaly:
    equipment_id: str
    event_key: str
    opened_at: int
    closed_at: int | None
    severity: str
    message: str
    active: bool = True

    def to_dict(self):
        return {
            "equipment_id": self.equipment_id,
            "event_key": self.event_key,
            "opened_at": self.opened_at,
            "closed_at": self.closed_at,
            "severity": self.severity,
            "message": self.message,
            "active": self.active,
        }
