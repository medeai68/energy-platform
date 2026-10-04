"""Energy platform server - stdlib HTTP server.

Includes the Digital Twin, AI diagnostics, sensor dataset bridge and Energy
Intelligence endpoints. No third-party packages are required.
"""

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from sim.engine import SimulationEngine
from ai.agent import diagnose
from intelligence.engine import EnergyIntelligence

WEB_DIR = Path(__file__).parent / "web"
engine = SimulationEngine()
intelligence = EnergyIntelligence()
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


def current_snapshot(with_intelligence=True):
    snap = engine.snapshot()
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
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/":
            self._send(200, (WEB_DIR / "index.html").read_text(encoding="utf-8"),
                       STATIC_TYPES[".html"])
        elif path == "/api/state":
            self._json(200, current_snapshot())
        elif path == "/api/intelligence":
            snap = engine.snapshot()
            self._json(200, intelligence.analyze(snap, persist=True))
        elif path == "/api/intelligence/report":
            snap = engine.snapshot()
            self._json(200, intelligence.report(snap))
        elif path == "/api/intelligence/history":
            self._json(200, intelligence.history())
        elif path.startswith("/api/device/"):
            dev_id = path.rsplit("/", 1)[-1]
            detail = engine.device_detail(dev_id)
            if detail is None:
                self._json(404, {"error": f"unknown device '{dev_id}'"})
            else:
                self._json(200, detail)
        elif path in ("/app.js", "/style.css", "/energy-intelligence.js", "/energy-intelligence.css"):
            f = WEB_DIR / path.lstrip("/")
            if f.is_file():
                self._send(200, f.read_text(encoding="utf-8"), STATIC_TYPES.get(f.suffix, "text/plain"))
            else:
                self._json(404, {"error": "not found"})
        elif path == "/favicon.ico":
            self._send(204, "")
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_body()
        if body is None:
            self._json(400, {"error": "invalid JSON body"})
            return

        if path == "/api/fault":
            ok = engine.set_fault(body.get("device_id"), body.get("fault_id"),
                                  bool(body.get("active")))
            self._json(200 if ok else 400, {"ok": ok})

        elif path == "/api/control":
            action = body.get("action")
            value = body.get("value")
            if action == "speed":
                engine.set_speed(value)
            elif action == "pause":
                engine.set_paused(bool(value))
            elif action == "weather":
                engine.set_weather(value)
            elif action == "reset":
                engine.reset()
            else:
                self._json(400, {"error": f"unknown action '{action}'"})
                return
            self._json(200, {"ok": True})

        elif path == "/api/ai/diagnose":
            self._diagnose(body)

        elif path == "/api/intelligence/scenario":
            snap = engine.snapshot()
            result = intelligence.scenario(
                snap,
                device_id=body.get("device_id"),
                reduction_pct=body.get("reduction_pct", 100),
                hours=body.get("hours", 8),
            )
            self._json(200, result)

        else:
            self._json(404, {"error": "not found"})

    def _diagnose(self, body):
        dev_id = body.get("device_id")
        snap = engine.snapshot()
        device = next((d for d in snap["devices"] if d["id"] == dev_id), None)
        if device is None:
            self._json(404, {"error": f"unknown device '{dev_id}'"})
            return

        event = next((e for e in snap["anomalies"] if e["device_id"] == dev_id), None)
        if event is None:
            event = next((e for e in snap["events"] if e["device_id"] == dev_id), None)
        if event is None:
            rel = device.get("rel")
            event = {
                "severity": "warning",
                "message": "Current residual outside the expected band",
                "device_id": dev_id,
                "device_name": device["name"],
                "day": snap["sim"]["day"],
                "time": snap["sim"]["time"],
            }
        else:
            rel = device.get("rel")

        diagnosis = diagnose(device, event, rel)
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

    threading.Thread(target=run_engine_loop, daemon=True, name="sim-engine").start()
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


if __name__ == "__main__":
    main()
