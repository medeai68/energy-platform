"""Virtual fault catalog.

Each fault is a scripted degradation that can be injected into the digital
twin through the UI. Faults only affect the *actual* (virtual sensor) power
values - the *expected* values always come from the healthy model. That gap
between actual and expected is what the anomaly detector and the AI agent
work on.
"""

FAULTS = {
    "solar": [
        {
            "id": "soiling",
            "name": "Soiling / dust",
            "description": "Dust accumulation on panels reduces irradiance capture by ~15%.",
            "severity": "warning",
        },
        {
            "id": "shading",
            "name": "Partial shading",
            "description": "New obstruction (vegetation, adjacent structure) shades part of the array, ~28% loss.",
            "severity": "serious",
        },
        {
            "id": "degradation",
            "name": "Cell degradation",
            "description": "Aging cells lose conversion efficiency, ~10% output loss.",
            "severity": "warning",
        },
        {
            "id": "panel_failure",
            "name": "Panel / string failure",
            "description": "A string of panels is electrically isolated, ~40% output loss.",
            "severity": "critical",
        },
    ],
    "inverter": [
        {
            "id": "eff_drop",
            "name": "Efficiency drop",
            "description": "Conversion efficiency falls from 97% to 89% (overheating, aging).",
            "severity": "warning",
        },
        {
            "id": "derate",
            "name": "Thermal derating",
            "description": "Inverter caps output at 70% of rated power to protect itself.",
            "severity": "serious",
        },
        {
            "id": "offline",
            "name": "Inverter offline",
            "description": "Inverter trips and delivers zero AC power.",
            "severity": "critical",
        },
    ],
    "hvac": [
        {
            "id": "overconsumption",
            "name": "Excessive consumption",
            "description": "AC draws ~45% more power than the cooling demand requires (leak, dirty coils).",
            "severity": "serious",
        },
        {
            "id": "short_cycle",
            "name": "Short cycling",
            "description": "Compressor rapidly cycles on/off, causing erratic, inefficient operation.",
            "severity": "serious",
        },
        {
            "id": "unit_outage",
            "name": "Unit outage",
            "description": "One of the three AC units trips offline (~12 kW of capacity lost).",
            "severity": "serious",
        },
    ],
    "lighting": [
        {
            "id": "night_on",
            "name": "Lights on at night",
            "description": "Lighting stays fully on during night hours (stuck relay / schedule error).",
            "severity": "serious",
        },
        {
            "id": "always_on",
            "name": "Lights always on",
            "description": "Lighting ignores the schedule and dimming entirely.",
            "severity": "serious",
        },
    ],
    "plugs": [
        {
            "id": "vampire",
            "name": "Vampire load",
            "description": "Equipment left running after hours adds ~3.5 kW at night.",
            "severity": "warning",
        },
    ],
    "panel": [
        {
            "id": "reduced_output",
            "name": "Reduced output (cell degradation)",
            "description": "Aged or micro-cracked cells cut this panel's output by ~15%.",
            "severity": "warning",
        },
        {
            "id": "overheating",
            "name": "Overheating (hot spot)",
            "description": "A hot spot raises cell temperature ~25°C and cuts output by ~28%.",
            "severity": "serious",
        },
        {
            "id": "disconnected",
            "name": "Disconnected (open circuit)",
            "description": "A failed connector or damaged cable isolates the panel - it delivers no power.",
            "severity": "critical",
        },
    ],
    "room_light": [
        {
            "id": "night_on",
            "name": "Lights on at night",
            "description": "The room's lighting stays fully on during night hours (stuck relay / schedule error).",
            "severity": "serious",
        },
        {
            "id": "always_on",
            "name": "Lights always on",
            "description": "The room ignores the schedule and dimming entirely.",
            "severity": "serious",
        },
    ],
    "room_plugs": [
        {
            "id": "vampire",
            "name": "Vampire load",
            "description": "Computers and monitors left running after hours keep drawing power at night.",
            "severity": "warning",
        },
        {
            "id": "overload",
            "name": "Overloaded circuit",
            "description": "Extra equipment plugged into the room's circuit raises daytime draw by ~25%.",
            "severity": "serious",
        },
    ],
    "fcu": [
        {
            "id": "overconsumption",
            "name": "Excessive consumption",
            "description": "The fan-coil draws ~45% more power than the cooling demand requires.",
            "severity": "serious",
        },
        {
            "id": "short_cycle",
            "name": "Short cycling",
            "description": "The fan rapidly cycles on/off, causing erratic, inefficient operation.",
            "severity": "serious",
        },
        {
            "id": "unit_outage",
            "name": "Unit outage",
            "description": "The fan-coil trips offline and delivers no cooling to its floor.",
            "severity": "serious",
        },
    ],
    "elevator": [
        {
            "id": "standby_drift",
            "name": "Standby heater drift",
            "description": "Cab standby heating sticks on at night, adding ~1.6 kW after hours.",
            "severity": "warning",
        },
        {
            "id": "regen_fault",
            "name": "Regeneration failure",
            "description": "Braking energy recovery fails; daytime consumption rises ~18%.",
            "severity": "serious",
        },
    ],
    "server_ups": [
        {
            "id": "battery_degraded",
            "name": "Battery degradation",
            "description": "Aging battery cells keep trickle-charging, adding ~1.3 kW continuously.",
            "severity": "warning",
        },
        {
            "id": "cooling_fault",
            "name": "Cooling failure",
            "description": "A failed cooling fan raises consumption ~22% on warm days.",
            "severity": "serious",
        },
    ],
    "ev_charger": [
        {
            "id": "overconsumption",
            "name": "Unscheduled charging",
            "description": "A vehicle charges outside the scheduled window, adding ~3 kW at night.",
            "severity": "warning",
        },
        {
            "id": "derated",
            "name": "Charger derated",
            "description": "The charger limits itself to ~55% of rated output (connector / cooling issue).",
            "severity": "serious",
        },
    ],
    "water_heater": [
        {
            "id": "leak",
            "name": "Hot water leak",
            "description": "A leaking pipe keeps the heater cycling, adding ~0.9 kW continuously.",
            "severity": "serious",
        },
        {
            "id": "stuck_element",
            "name": "Stuck heating element",
            "description": "A failed thermostat leaves the element on at full power around the clock.",
            "severity": "serious",
        },
    ],
    "battery_storage": [
        {
            "id": "reduced_capacity",
            "name": "Reduced capacity",
            "description": "Aged cells cap the usable capacity at 60%, so charging stops early.",
            "severity": "warning",
        },
        {
            "id": "charge_fault",
            "name": "Charging fault",
            "description": "The charge controller refuses to charge — the battery only discharges.",
            "severity": "serious",
        },
    ],
}


# Sensor-layer faults: these corrupt the *measurement* only, so the physical
# equipment may be perfectly healthy. Available to every device kind; the UI
# and the AI agent label them distinctly from equipment faults.
SENSOR_FAULTS = [
    {
        "id": "sensor_drift",
        "name": "Sensor drift",
        "description": "The power transducer reads ~35% high — a measurement bias, not equipment behavior.",
        "severity": "serious",
        "layer": "sensor",
    },
    {
        "id": "sensor_stuck",
        "name": "Stuck sensor",
        "description": "The reading freezes at its last value, hiding any real change in power.",
        "severity": "serious",
        "layer": "sensor",
    },
]


def faults_for(device_kind):
    """Return the fault catalog for a device kind (equipment faults plus the
    sensor layer available to every kind)."""
    return FAULTS.get(device_kind, []) + SENSOR_FAULTS
