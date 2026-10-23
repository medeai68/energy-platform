"""IoT/MQTT integration — SIMULATED.

This package contains a mock MQTT broker and an adapter pair that publish and
ingest deterministic measurement messages through the platform's canonical
``equipment_store.import_measurement`` entry point (source='live'). No real
broker, network or hardware is involved; every message is labelled simulated.
"""
