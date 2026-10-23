"""Energy platform server - stdlib HTTP server.

Includes the Digital Twin, AI diagnostics, sensor dataset bridge and Energy
Intelligence endpoints. No third-party packages are required.
"""

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from sim.engine import SimulationEngine
from sim.fleet import FleetDataset
from iot.mock_broker import MockBroker, MockPublisher
from iot.adapter import MqttAdapter
from ai.agent import diagnose
from intelligence.engine import EnergyIntelligence
from equipment.calculations import (
    calculate_energy, compare_baseline_scenario, scenario_energy,
)
from equipment.model import CATEGORY_LABELS
from equipment.playback import build_playback
from equipment.store import EquipmentStore

WEB_DIR = Path(__file__).parent / "web"
DB_PATH = os.environ.get("ENERGY_DB_PATH", "data/energy_intelligence.db")
engine = SimulationEngine()
intelligence = EnergyIntelligence(db_path=DB_PATH)
equipment_store = EquipmentStore(DB_PATH)

# One equipment measurement sample every N real seconds (the measurement
# timestamp is sim time; the cadence is wall-clock so it is independent of
# the simulation speed). UPSERT keys make paused simulations idempotent.
EQUIPMENT_SAMPLE_SECONDS = 10
#: Request bodies are small JSON documents; refuse anything larger before
#: reading it so a local client cannot make the server allocate unbounded RAM.
MAX_BODY_BYTES = 64 * 1024
WEATHER_MODES = ("auto", "clear", "partly", "cloudy", "overcast")
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def run_engine_loop():
    while True:
        engine.tick()
        time.sleep(1.0)


def run_equipment_loop():
    first = True
    while True:
        try:
            # Full anomaly list: the store must not close an active alarm
            # merely because it fell outside the dashboard's top-10 window.
            snap = engine.snapshot(full_anomalies=True)
            if first:
                equipment_store.sync_registry(snap)
                first = False
            equipment_store.record_sample(snap)
        except Exception as exc:  # never let persistence kill the sim
            print(f"[equipment] persistence error: {exc}")
        time.sleep(EQUIPMENT_SAMPLE_SECONDS)


# Fleet monitoring (Phase 6): the imported-dataset site (Warehouse 12) is
# sampled from a deterministic dataset; the live site (Office 3) is fed by
# the simulated MQTT adapter below. Both use wall-clock timestamps so they
# keep producing samples while the campus simulation is paused.
FLEET_INTERVAL_SECONDS = 15


def run_fleet_loop():
    fleet = FleetDataset()
    first = True
    while True:
        try:
            if first:
                fleet.ensure_registered(equipment_store)
                first = False
            fleet.feed_once(equipment_store)
        except Exception as exc:  # never let persistence kill the sim
            print(f"[fleet] import error: {exc}")
        time.sleep(FLEET_INTERVAL_SECONDS)


MQTT_DRAIN_SECONDS = 5


def run_mqtt_loop():
    """SIMULATED MQTT integration: an in-process mock broker + publisher
    feed the 'live' fleet site through the canonical import_measurement
    entry point. No real broker, network or hardware is involved."""
    broker = MockBroker()
    publisher = MockPublisher(broker, interval=10.0)
    adapter = MqttAdapter(broker, equipment_store)
    adapter.start()
    publisher.start()
    print("[mqtt] simulated MQTT broker active (in-process mock, no real devices)")
    while True:
        try:
            adapter.drain()
        except Exception as exc:  # never let the adapter kill the server
            print(f"[mqtt] adapter error: {exc}")
        time.sleep(MQTT_DRAIN_SECONDS)


def current_snapshot(with_intelligence=True):
    snap = engine.snapshot()
    # Per-equipment data availability (wall-clock age of the last persisted
    # sample) feeds the "data availability" visualization mode.
    snap["availability"] = equipment_store.availability()
    if with_intelligence:
        snap["intelligence"] = intelligence.analyze(snap, persist=False)
    return snap


class Handler(BaseHTTPRequestHandler):
    server_version = "EnergyPlatform/0.2"

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, payload):
        self._send(code, payload)

    def _read_body(self):
        """Read one JSON object body, or raise ValueError for a bad request.

        ``Content-Length`` is validated before any bytes are read: a malformed
        length or an oversized body must not reach ``rfile.read``. Oversized
        requests also close the connection, since their body is deliberately
        left unread.
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            raise ValueError("invalid Content-Length header") from None
        if length < 0:
            raise ValueError("invalid Content-Length header")
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            raise ValueError(
                f"request body too large (maximum {MAX_BODY_BYTES} bytes)")
        if length == 0:
            return {}
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        if not isinstance(body, dict):
            raise ValueError("JSON body must be an object")
        return body

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/":
            self._send(200, (WEB_DIR / "index.html").read_text(encoding="utf-8"),
                       STATIC_TYPES[".html"])
        elif path == "/api/state":
            self._json(200, current_snapshot())
        elif path == "/api/intelligence":
            # GET is read-only: the dashboard polls this route, and persisting
            # every poll filled intelligence_snapshots with duplicate rows.
            snap = engine.snapshot()
            self._json(200, intelligence.analyze(snap, persist=False))
        elif path == "/api/intelligence/report":
            snap = engine.snapshot()
            self._json(200, intelligence.report(snap))
        elif path == "/api/intelligence/history":
            self._json(200, intelligence.history())
        elif path == "/api/alarms":
            self._alarms(parse_qs(urlparse(self.path).query))
        elif path == "/api/playback":
            self._playback()
        elif path == "/api/equipment":
            self._equipment_list()
        elif path.startswith("/api/equipment/"):
            eq_id = path.rsplit("/", 1)[-1]
            detail = equipment_store.equipment_detail(eq_id)
            if detail is None:
                self._json(404, {"error": f"unknown equipment '{eq_id}'"})
            else:
                self._json(200, detail)
        elif path.startswith("/api/device/"):
            dev_id = path.rsplit("/", 1)[-1]
            detail = self._device_detail(dev_id)
            if detail is None:
                self._json(404, {"error": f"unknown device '{dev_id}'"})
            else:
                self._json(200, detail)
        elif path in ("/scene.js", "/app.js", "/building.js", "/viz.js", "/navigator.js",
                      "/playback.js", "/style.css", "/energy-intelligence.js",
                      "/energy-intelligence.css", "/alarms.js",
                      "/perf.js", "/net.js", "/keyboard.js", "/fallback.js",
                      "/camera-controls.js", "/shell.js", "/shell.css",
                      "/twin3d.js", "/twin3d-geometry.js", "/twin3d-kit.js",
                      "/twin3d-arch.js", "/twin3d-interiors.js", "/twin3d-presentation.js",
                      "/vendor/three.module.js", "/vendor/three.core.js"):
            f = WEB_DIR / path.lstrip("/")
            if f.is_file():
                self._send(200, f.read_text(encoding="utf-8"), STATIC_TYPES.get(f.suffix, "text/plain"))
            else:
                self._json(404, {"error": "not found"})
        elif path == "/favicon.ico":
            self._send(204, "")
        else:
            self._json(404, {"error": "not found"})

    def _alarms(self, query):
        """Alarm center feed: persisted anomalies + operator follow-up.

        This is a read-only GET. The detector owns whether a condition is
        active; state is persisted by the 10-second sampling loop and
        immediately after a fault mutation (``POST /api/fault``), so polling
        the alarm feed cannot rewrite alarm records.
        """
        status = (query.get("status") or ["active"])[0]
        severity = (query.get("severity") or [""])[0]
        building = (query.get("building") or [""])[0]
        limit = (query.get("limit") or ["100"])[0]
        try:
            items = equipment_store.list_alarms(
                status=status, severity=severity,
                building_id=building, limit=limit)
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        self._json(200, {
            "items": items,
            "counts": equipment_store.alarm_counts(),
            "filters": {
                "status": status,
                "severity": severity or None,
                "building": building or None,
                "limit": int(limit) if str(limit).isdigit() else 100,
            },
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": "simulated",
            "note": ("Alarms are derived from simulated sensor anomalies and "
                     "operator actions. No physical devices are connected."),
        })

    def _alarm_action(self, body, action):
        equipment_id = body.get("equipment_id")
        event_key = body.get("event_key")
        if (not isinstance(equipment_id, str) or not equipment_id
                or not isinstance(event_key, str) or not event_key):
            self._json(400, {"error": "equipment_id and event_key are required"})
            return
        try:
            if action == "acknowledge":
                alarm = equipment_store.acknowledge_alarm(
                    equipment_id, event_key, body.get("operator"))
            else:
                alarm = equipment_store.resolve_alarm(
                    equipment_id, event_key, body.get("operator"),
                    body.get("note"))
        except ValueError as exc:
            self._json(409, {"error": str(exc)})
            return
        if alarm is None:
            self._json(404, {"error": "unknown alarm"})
            return
        self._json(200, {"ok": True, "alarm": alarm,
                         "counts": equipment_store.alarm_counts()})

    @staticmethod
    def _device_detail(dev_id):
        """Live snapshot + equipment model + alerts + freshness for the
        inspector panel. Values that are not available stay absent/null -
        the UI must not substitute fabricated readings."""
        detail = engine.device_detail(dev_id)
        if detail is None:
            return None
        detail["type_label"] = CATEGORY_LABELS.get(detail["kind"], detail["kind"])
        detail["freshness"] = {
            "age_seconds": round(max(0.0, time.time() - engine.last_tick_wall), 1),
            "paused": engine.paused,
        }
        # Persisted equipment model (may be None until the first sample).
        detail["persisted"] = equipment_store.equipment_detail(dev_id, history=240)
        detail["energy"] = Handler._energy_block(detail)
        return detail

    @staticmethod
    def _energy_block(detail):
        """Rated / measured / simulated / calculated, kept distinct.

        The *measured power* series comes from the equipment's own data
        source: the twin's tick-cadence readings for simulated equipment,
        canonical persisted measurements for live/imported equipment.  The
        calculated estimate is derived from that series with the documented
        formulas in ``equipment/calculations.py``.  The engine's integrated
        counter is only reported as *simulated* consumption and only for
        simulated equipment - it is never labelled measured.
        """
        source = detail.get("source", "simulated")
        persisted = detail.get("persisted") or {}
        scenario = persisted.get("scenario") if source == "simulated" else None

        if source == "simulated":
            # Engine history is one sample per tick; a tick advances
            # engine.speed simulation minutes.  Allow two ticks between
            # samples before treating the gap as unsupported.
            series = [(h.get("t"), h.get("actual"))
                      for h in detail.get("history") or []]
            max_gap = max(5.0, float(engine.speed) * 2.0)
            measured_kw = detail.get("actual")
            measured_at = detail.get("measured_at")
            operating_hours = detail.get("operating_hours")
            simulated_kwh = detail.get("energy_today_kwh")
        else:
            # Live/imported readings: use the canonical persisted series.
            # Those feeds timestamp samples in wall-clock Unix *seconds*,
            # while ``calculate_energy`` works in minutes. Convert before
            # integrating: without this, a 15-second sample interval was
            # treated as 15 minutes and the "last 24 h" baseline was really
            # the last 24 minutes.
            hist = persisted.get("history") or []
            series = [
                (float(h["measured_at"]) / 60.0, h.get("actual_kw"))
                for h in hist if h.get("measured_at") is not None
            ]
            max_gap = max(1.0, (EQUIPMENT_SAMPLE_SECONDS * 3.0) / 60.0)
            latest = hist[-1] if hist else None
            measured_kw = latest.get("actual_kw") if latest else None
            measured_at = ({"abs_minutes": latest["measured_at"],
                            "day": latest["measured_day"],
                            "time": latest["measured_time"]}
                           if latest else None)
            operating_hours = latest.get("operating_hours") if latest else None
            simulated_kwh = None  # never present the simulation counter as live data

        calculated = calculate_energy(series, max_gap_minutes=max_gap)

        # Baseline for scenario comparison: the most recent simulated day of
        # power history (never more than 24 h).  This is still a calculated
        # estimate from power readings, not a meter register.
        baseline_series = []
        if series:
            latest = series[-1][0]
            if latest is not None:
                cutoff = latest - 1440.0
                baseline_series = [s for s in series
                                   if s[0] is not None and s[0] >= cutoff]
        baseline_calc = calculate_energy(
            baseline_series, max_gap_minutes=max_gap)
        baseline = {
            "energy_kwh": baseline_calc.get("energy_kwh"),
            "status": baseline_calc.get("status"),
            "reason": baseline_calc.get("reason"),
            "window": baseline_calc.get("window"),
            "duration_hours": baseline_calc.get("duration_hours"),
            "method": baseline_calc.get("method"),
            "basis": "calculated",
            "source": source,
            "note": ("Baseline calculated from the last 24 h of power "
                     "history with the documented formulas; not metered "
                     "consumption."),
        }
        comparison = None
        if (scenario and baseline_calc.get("status") == "ok"
                and baseline_calc.get("energy_kwh") is not None
                and baseline_calc.get("window")
                and (baseline_calc.get("duration_hours") or 0) >= 1.0):
            try:
                comparison = compare_baseline_scenario(
                    baseline_calc["energy_kwh"],
                    baseline_calc["window"]["start_minutes"],
                    baseline_calc["window"]["end_minutes"],
                    scenario.get("rated_kw"),
                    scenario.get("operating_hours"),
                    scenario.get("load_factor", 1.0),
                    scenario.get("schedule_start", 0.0),
                    baseline_calc.get("duration_hours"),
                )
                comparison["baseline"]["source"] = source
            except ValueError:
                comparison = None
        return {
            "rated_power_kw": detail.get("rating"),
            "measured_power_kw": measured_kw,
            "measured_at": measured_at,
            "measurement_source": source,
            "operating_hours": operating_hours,
            "simulated_energy_kwh": simulated_kwh,
            "calculated": calculated,
            "baseline": baseline,
            "comparison": comparison,
            "scenario": scenario,
            "note": ("Calculated estimates are derived from measured power "
                     "with the documented formulas; they are not metered "
                     "consumption."),
        }

    def _playback(self):
        """Historical energy playback for one simulation day.

        Query: ``?bucket=60&day=2`` (bucket minutes 5..1440, day defaults to
        the current simulation day).  Calculated from the engine's per-device
        tick history; the snapshot and history series are acquired separately
        because the engine lock is not re-entrant.
        """
        query = parse_qs(urlparse(self.path).query)
        bucket = (query.get("bucket") or [60])[0]
        day = (query.get("day") or [None])[0]
        try:
            snap = engine.snapshot()
            if day in (None, ""):
                day = snap["sim"]["day"]
            payload = build_playback(
                snap, engine.history_series(), bucket_minutes=bucket, day=day)
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        self._json(200, payload)

    def _equipment_list(self):
        """The persisted equipment registry + latest measurement per device.

        Optional filters: ?building=b1&floor=b1f2&room=b1f2r2&category=fcu
        &source=simulated
        """
        query = parse_qs(urlparse(self.path).query)
        items = equipment_store.list_equipment()
        want = {k: (query.get(k) or [None])[0]
                for k in ("building", "floor", "room", "category", "source")}

        def match(item):
            parent = item.get("parent") or {}
            if want["building"] and parent.get("building") != want["building"]:
                return False
            if want["floor"] and parent.get("floor") != want["floor"]:
                return False
            if want["room"] and parent.get("room") != want["room"]:
                return False
            if want["category"] and item.get("category") != want["category"]:
                return False
            if want["source"] and item.get("source") != want["source"]:
                return False
            return True

        if any(want.values()):
            items = [i for i in items if match(i)]
        self._json(200, {
            "count": len(items),
            "stats": equipment_store.stats(),
            "equipment": items,
        })

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self._read_body()
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        if body is None:
            self._json(400, {"error": "invalid JSON body"})
            return

        if path == "/api/fault":
            device_id = body.get("device_id")
            fault_id = body.get("fault_id")
            active = body.get("active")
            if (not isinstance(device_id, str) or not device_id
                    or not isinstance(fault_id, str) or not fault_id):
                self._json(400, {"error": "device_id and fault_id are required"})
                return
            if not isinstance(active, bool):
                self._json(400, {"error": "active must be true or false"})
                return
            ok = engine.set_fault(device_id, fault_id, active)
            if ok:
                # A mutation may change detector state immediately; sync the
                # persisted alarms here (GET /api/alarms stays read-only).
                try:
                    equipment_store.refresh_anomalies(
                        engine.snapshot(full_anomalies=True))
                except Exception as exc:  # never fail the mutation on sync
                    print(f"[alarms] sync error: {exc}")
            self._json(200 if ok else 400, {"ok": ok})

        elif path == "/api/alarms/acknowledge":
            self._alarm_action(body, "acknowledge")

        elif path == "/api/alarms/resolve":
            self._alarm_action(body, "resolve")

        elif path == "/api/control":
            self._control(body)

        elif path == "/api/ai/diagnose":
            self._diagnose(body)

        elif path == "/api/intelligence/scenario":
            snap = engine.snapshot()
            try:
                result = intelligence.scenario(
                    snap,
                    device_id=body.get("device_id"),
                    reduction_pct=body.get("reduction_pct", 100),
                    hours=body.get("hours", 8),
                )
            except (TypeError, ValueError) as exc:
                self._json(400, {"error": str(exc)})
                return
            self._json(200, result)

        elif path.startswith("/api/equipment/") and path.endswith("/scenario"):
            self._scenario(body, path)

        elif path == "/api/energy/calculate":
            # Pure calculation endpoint:
            # E = rated power x load factor x operating hours.
            try:
                result = scenario_energy(
                    body.get("rated_kw"), body.get("operating_hours"),
                    body.get("load_factor", 1.0),
                    body.get("schedule_start", 0.0))
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
                return
            self._json(200, result)

        else:
            self._json(404, {"error": "not found"})

    def _control(self, body):
        """Apply one simulation control, rejecting malformed values.

        Previously a string/None speed raised inside the engine (a reset
        connection instead of a 400), ``pause`` used ``bool(value)`` (so the
        string "false" paused the simulation) and an unknown weather mode was
        accepted with ``ok: true``.
        """
        action = body.get("action")
        value = body.get("value")
        if action == "speed":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                self._json(400, {"error": "speed must be a number"})
                return
            if not 1 <= value <= 1440:
                self._json(400, {"error": "speed must be between 1 and 1440"})
                return
            engine.set_speed(value)
        elif action == "pause":
            if not isinstance(value, bool):
                self._json(400, {"error": "pause value must be true or false"})
                return
            engine.set_paused(value)
        elif action == "weather":
            if value not in WEATHER_MODES:
                self._json(400, {"error": (
                    "weather must be one of: " + ", ".join(WEATHER_MODES))})
                return
            engine.set_weather(value)
        elif action == "reset":
            engine.reset()
        else:
            self._json(400, {"error": f"unknown action '{action}'"})
            return
        self._json(200, {"ok": True})

    def _scenario(self, body, path):
        """Save / clear a simulated-scenario configuration for one equipment."""
        eq_id = path[len("/api/equipment/"):-len("/scenario")]
        try:
            if body.get("clear") is True:
                cleared = equipment_store.clear_scenario(eq_id)
                self._json(200, {"ok": True, "cleared": cleared,
                                 "scenario": None})
                return
            scenario = equipment_store.set_scenario(
                eq_id, body.get("rated_kw"), body.get("operating_hours"),
                body.get("load_factor", 1.0),
                body.get("schedule_start", 0.0))
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        self._json(200, {"ok": True, "scenario": scenario})

    def _diagnose(self, body):
        dev_id = body.get("device_id")
        # Diagnosis must see every live anomaly. The dashboard snapshot caps
        # its list at ten and its event history at thirty entries, so using it
        # here can hide a real anomaly on the device being inspected and make
        # a faulted device look healthy.
        snap = engine.snapshot(full_anomalies=True)
        device = next((d for d in snap["devices"] if d["id"] == dev_id), None)
        if device is None:
            device = next((d for d in snap.get("panels", []) if d["id"] == dev_id), None)
        if device is None:
            device = next((d for d in snap.get("equipment", []) if d["id"] == dev_id), None)
        if device is None:
            self._json(404, {"error": f"unknown device '{dev_id}'"})
            return

        # Only a live detector event is an anomaly. The fallback previously
        # invented a warning ("Current residual outside the expected band")
        # when nothing was active, so a healthy device was diagnosed as if it
        # had faulted. The event history is also filtered to active,
        # non-operator entries - an injected-fault log line is not an anomaly.
        event = next(
            (e for e in snap["anomalies"] if e.get("device_id") == dev_id),
            None,
        )
        if event is None:
            event = next(
                (e for e in snap.get("events", [])
                 if e.get("device_id") == dev_id and e.get("active")
                 and e.get("severity") != "operator"),
                None,
            )
        rel = device.get("rel")

        diagnosis = diagnose(device, event or {}, rel)
        self._json(200, {
            "device": device,
            "anomaly": event,
            "diagnosis": diagnosis,
        })

    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}")


def main():
    port = 8000
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])

    # The isolated development environment keeps the simulation paused
    # across restarts: the engine boots paused so it never advances unless
    # an operator explicitly resumes it.
    engine.set_paused(True)

    threading.Thread(target=run_engine_loop, daemon=True, name="sim-engine").start()
    threading.Thread(target=run_equipment_loop, daemon=True, name="equipment-store").start()
    threading.Thread(target=run_fleet_loop, daemon=True, name="fleet-feed").start()
    threading.Thread(target=run_mqtt_loop, daemon=True, name="mqtt-adapter").start()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("=" * 62)
    print("  Energy AI Platform - Digital Twin & Energy Intelligence")
    print(f"  Dashboard:  http://localhost:{port}")
    print("  Demo: inject a fault -> AI diagnosis -> energy impact -> recommendation")
    print("  Stop with Ctrl+C")
    print("=" * 62)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()
    finally:
        equipment_store.close()
        intelligence.close()


if __name__ == "__main__":
    main()
