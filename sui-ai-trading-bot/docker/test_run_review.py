#!/usr/bin/env python3
"""Contract tests for docker/run-review.py (stage-1 run review)."""
import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("run_review", os.path.join(HERE, "run-review.py"))
rr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rr)

BASE = 1_800_000_000


def candles_with_close_at(marks):
    """Flat 1.00 candles; marks override the close at specific timestamps."""
    close = {}
    t = BASE - 3600
    while t <= BASE + 90000:
        close[t] = marks.get(t, 1.00)
        t += 300
    high = {t: c * 1.001 for t, c in close.items()}
    low = {t: c * 0.999 for t, c in close.items()}
    return close, high, low, sorted(close)


def decision(missing=None, price=1.00, cts=BASE):
    cond = {"emaUp": True, "rsiRecovery": True, "histogramImproving": True}
    if missing:
        cond[missing] = False
    return {"action": "WAIT", "rule": "NO_SIGNAL", "cts": cts, "price": price,
            "cond": cond, "met": sum(1 for k in rr.CORE if cond.get(k))}


class AnalyzeTests(unittest.TestCase):
    def test_candidate_flag_fires_for_missing_emaup(self):
        candles = candles_with_close_at({BASE + 4 * 3600: 1.006})
        result = rr.analyze([decision(missing="emaUp") for _ in range(31)], candles)
        kinds = [f["kind"] for f in result["flags"]]
        self.assertIn("candidate", kinds)
        self.assertEqual(result["marginal"]["emaUp"]["n"], 31)
        self.assertAlmostEqual(result["marginal"]["emaUp"]["h"][4]["mean"], 0.6, places=6)

    def test_caution_flag_fires_and_no_candidate_when_negative(self):
        candles = candles_with_close_at({BASE + 4 * 3600: 0.995})
        result = rr.analyze([decision(missing="rsiRecovery") for _ in range(31)], candles)
        kinds = [f["kind"] for f in result["flags"]]
        self.assertIn("caution", kinds)
        self.assertNotIn("candidate", kinds)

    def test_no_flag_below_sample_threshold(self):
        candles = candles_with_close_at({BASE + 4 * 3600: 1.006})
        result = rr.analyze([decision(missing="emaUp") for _ in range(29)], candles)
        self.assertEqual(result["flags"], [])

    def test_forward_return_uses_decision_price(self):
        candles = candles_with_close_at({BASE + 3600: 1.02})
        result = rr.analyze([decision(missing=None)], candles)
        self.assertAlmostEqual(result["buckets"][3]["h"][1]["mean"], 2.0, places=6)


class FetchLimitTests(unittest.TestCase):
    def test_limit_covers_span_from_cts_seconds(self):
        decisions = [{"cts": BASE}, {"cts": BASE + 86400}]
        self.assertEqual(rr.compute_limit(decisions), 86400 // 300 + 2000)

    def test_limit_defaults_and_caps(self):
        self.assertEqual(rr.compute_limit([]), 2000)
        decisions = [{"cts": BASE}, {"cts": BASE + 300 * 20000}]
        self.assertEqual(rr.compute_limit(decisions), 10000)


class LoadDecisionsTests(unittest.TestCase):
    def test_loads_evidence_and_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "SUI_USDC.sqlite")
            conn = sqlite3.connect(db)
            conn.execute("CREATE TABLE strategy_decisions (id TEXT, timestamp INTEGER, json TEXT)")
            conn.execute("CREATE TABLE paper_orders (id TEXT, timestamp INTEGER, json TEXT)")
            conn.execute("CREATE TABLE paper_trades (id TEXT, timestamp INTEGER, json TEXT)")
            ev = {"action": "WAIT", "evidence": {
                "selectedRule": "NO_SIGNAL", "candleTimestamp": BASE,
                "inputs": {"price": 1.0},
                "conditions": {"emaUp": False, "rsiRecovery": True,
                               "histogramImproving": True}}}
            conn.execute("INSERT INTO strategy_decisions VALUES ('a', 1, ?)", (json.dumps(ev),))
            conn.commit()
            conn.close()
            decisions, orders, trades = rr.load_decisions(db)
            self.assertEqual(len(decisions), 1)
            self.assertEqual(decisions[0]["met"], 2)
            self.assertEqual((orders, trades), (0, 0))


if __name__ == "__main__":
    unittest.main()
