"""Phase 6 — fleet dataset + simulated MQTT integration tests.

Covers: registry seeding for the external sites (canonical sync_registry
path, correct sources), imported-dataset sampling through the canonical
import UPSERT, and the mock-broker → adapter round trip (source='live',
simulated flag enforced, idempotent canonical measurements).
"""

import json
import tempfile
import time
import unittest
from pathlib import Path

from equipment.store import EquipmentStore
from iot.adapter import MqttAdapter
from iot.mock_broker import MockBroker, MockPublisher, SITE_DEVICES
from sim.fleet import FleetDataset, SITE_A, SITE_B


class FleetTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = str(Path(self.tmp.name) / "fleet.db")
        self.store = EquipmentStore(self.db)
        self.addCleanup(self.store.close)
        self.fleet = FleetDataset()


class FleetRegistryTests(FleetTestBase):
    def test_external_sites_register_through_the_canonical_path(self):
        self.fleet.ensure_registered(self.store)
        items = {i["id"]: i for i in self.store.list_equipment()}
        self.assertEqual(len([i for i in items.values() if i["id"].startswith("ext-")]), 9)
        self.assertEqual(items["ext-a-chiller"]["source"], "imported")
        self.assertEqual(items["ext-b-fcu"]["source"], "live")
        self.assertEqual(items["ext-a-chiller"]["parent"]["building"], "ext-a")
        self.assertEqual(items["ext-b-ups"]["parent"]["building"], "ext-b")

    def test_registration_is_idempotent(self):
        self.fleet.ensure_registered(self.store)
        self.fleet.ensure_registered(self.store)
        n = sum(1 for i in self.store.list_equipment()
                if i["id"].startswith("ext-"))
        self.assertEqual(n, 9)


class ImportedFeedTests(FleetTestBase):
    def test_feed_imports_canonical_samples_for_the_imported_site(self):
        self.fleet.ensure_registered(self.store)
        self.fleet.feed_once(self.store)
        detail = self.store.equipment_detail("ext-a-chiller", history=10)
        self.assertEqual(len(detail["history"]), 1)
        row = detail["history"][0]
        self.assertEqual(row["source"], "imported")
        self.assertGreater(row["actual_kw"], 0)
        self.assertIn("feed", row["sensors"])
        # the live site is fed by the MQTT adapter, not the dataset
        detail_b = self.store.equipment_detail("ext-b-fcu", history=10)
        self.assertEqual(len(detail_b["history"]), 0)

    def test_same_timestamp_updates_in_place(self):
        self.fleet.ensure_registered(self.store)
        self.fleet.feed_once(self.store)
        first = self.store.equipment_detail("ext-a-chiller", history=10)
        self.fleet.feed_once(self.store)
        second = self.store.equipment_detail("ext-a-chiller", history=10)
        self.assertEqual(len(first["history"]), 1)
        self.assertEqual(len(second["history"]), 1)
        self.assertEqual(first["history"][0]["measured_at"],
                         second["history"][0]["measured_at"])


class MockMqttTests(FleetTestBase):
    def _broker_pair(self):
        broker = MockBroker()
        publisher = MockPublisher(broker, interval=60.0, seed=21)
        adapter = MqttAdapter(broker, self.store)
        return broker, publisher, adapter

    def test_publisher_emits_simulated_messages(self):
        broker, publisher, adapter = self._broker_pair()
        self.fleet.ensure_registered(self.store)
        adapter.start()
        publisher.start()
        try:
            # one publish cycle: 4 messages for Office 3
            for dev_id, name, kind, rating, base, amp in SITE_DEVICES:
                topic, payload = adapter.subscription.get(timeout=10)
                msg = json.loads(payload)
                self.assertEqual(msg["equipment_id"], dev_id)
                self.assertTrue(msg["simulated"])
                self.assertIn("no real broker", msg["note"])
            self.assertEqual(adapter.drain(), 0)
        finally:
            adapter.stop()
            publisher.stop()

    def test_adapter_imports_as_live_with_mock_label(self):
        broker, publisher, adapter = self._broker_pair()
        self.fleet.ensure_registered(self.store)
        adapter.start()
        publisher.start()
        try:
            # the publisher thread emits its first cycle asynchronously
            total = 0
            for _ in range(30):
                total += adapter.drain()
                if total >= 4:
                    break
                time.sleep(0.1)
            self.assertEqual(total, 4)
            detail = self.store.equipment_detail("ext-b-ups", history=10)
            self.assertEqual(len(detail["history"]), 1)
            self.assertEqual(detail["history"][0]["source"], "live")
            self.assertIn("mqtt", detail["history"][0]["sensors"])
        finally:
            adapter.stop()
            publisher.stop()

    def test_adapter_rejects_non_simulated_messages(self):
        broker, publisher, adapter = self._broker_pair()
        self.fleet.ensure_registered(self.store)
        adapter.start()
        broker.publish("energy/office3/x/measurement", json.dumps({
            "equipment_id": "ext-b-fcu",
            "actual_kw": 1.0, "expected_kw": 1.0,
            "status": "ok", "measured_at": 123456,
            "simulated": False,
        }))
        self.assertEqual(adapter.drain(), 0)
        self.assertEqual(adapter.errors, 1)
        self.assertEqual(len(self.store.equipment_detail("ext-b-fcu", history=10)["history"]), 0)
        adapter.stop()


if __name__ == "__main__":
    unittest.main()
