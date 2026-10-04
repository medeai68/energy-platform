"""Facade joining metrics, priorities, recommendations and reports."""

from __future__ import annotations

from .metrics import calculate
from .persistence import IntelligenceStore
from .recommendations import recommendations
from .reports import daily_report, savings_scenario
from .scoring import rank_events


class EnergyIntelligence:
    def __init__(self, electricity_rate=0.15, grid_co2_kg_per_kwh=0.40,
                 db_path="data/energy_intelligence.db"):
        self.electricity_rate = electricity_rate
        self.grid_co2_kg_per_kwh = grid_co2_kg_per_kwh
        self.store = IntelligenceStore(db_path)

    def analyze(self, snapshot, persist=True):
        metrics = calculate(snapshot, self.electricity_rate, self.grid_co2_kg_per_kwh)
        ranked = rank_events(snapshot)
        recs = recommendations(snapshot, ranked)
        result = {
            **metrics,
            "prioritized_events": ranked,
            "recommendations": recs,
        }
        if persist:
            self.store.record(snapshot, result)
        return result

    def report(self, snapshot):
        result = self.analyze(snapshot, persist=True)
        return daily_report(snapshot, result, result["prioritized_events"], result["recommendations"])

    def scenario(self, snapshot, device_id=None, reduction_pct=100, hours=8):
        return savings_scenario(
            snapshot, device_id, reduction_pct, hours,
            self.electricity_rate, self.grid_co2_kg_per_kwh
        )

    def history(self, limit=100):
        return self.store.recent(limit)
