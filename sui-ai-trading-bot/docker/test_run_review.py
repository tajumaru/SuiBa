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
    ordered = sorted(close)
    ema, value = {}, None
    for t in ordered:
        value = close[t] if value is None else value + (2 / 51) * (close[t] - value)
        ema[t] = value
    gap = {t: 0.0 for t in ordered}
    return close, high, low, ordered, ema, gap


def trending_candles(step):
    """Three days of steadily moving closes for regime classification."""
    close, t, price = {}, BASE - 3 * 86400, 1.00
    while t <= BASE + 3600:
        close[t] = price
        price *= (1 + step)
        t += 300
    high = {t: c * 1.001 for t, c in close.items()}
    low = {t: c * 0.999 for t, c in close.items()}
    ordered = sorted(close)
    ema, value = {}, None
    for t in ordered:
        value = close[t] if value is None else value + (2 / 51) * (close[t] - value)
        ema[t] = value
    gap = {t: 0.0 for t in ordered}
    return close, high, low, ordered, ema, gap


def decision(missing=None, price=1.00, cts=BASE, cond_extra=None, cur=None, prev=None):
    cond = {"emaUp": True, "rsiRecovery": True, "histogramImproving": True,
            "latestVolumePositive": True, "previousVolumePositive": True,
            "volumeChangeExceeded": False}
    if missing:
        cond[missing] = False
    if cond_extra:
        cond.update(cond_extra)
    return {"action": "WAIT", "rule": "NO_SIGNAL", "cts": cts, "price": price,
            "cond": cond, "met": sum(1 for k in rr.CORE if cond.get(k)),
            "cur": cur or {"ema20": 1.01, "ema50": 1.00, "rsi": 50.0},
            "prev": prev or {"rsi": 40.0}}


class AnalyzeTests(unittest.TestCase):
    def test_candidate_flag_fires_for_missing_emaup(self):
        candles = candles_with_close_at({BASE + 4 * 3600: 1.012})
        result = rr.analyze([decision(missing="emaUp") for _ in range(31)], candles)
        kinds = [f["kind"] for f in result["flags"]]
        self.assertIn("candidate", kinds)
        self.assertEqual(result["marginal"]["emaUp"]["n"], 31)
        self.assertAlmostEqual(result["marginal"]["emaUp"]["h"][4]["mean"], 1.2, places=6)
        # Flags are judged net of the 0.6% round-trip cost.
        self.assertAlmostEqual(result["marginal"]["emaUp"]["net"][4]["mean"], 0.6, places=6)

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


class VariantTests(unittest.TestCase):
    def test_novol_fires_through_volume_gate_but_base_does_not(self):
        d = decision(cond_extra={"volumeChangeExceeded": True})
        self.assertTrue(rr.pred_novol(d))
        self.assertFalse(rr.pred_base(d))

    def test_rsi45_needs_a_cross_of_45(self):
        d = decision(prev={"rsi": 44.0}, cur={"ema20": 1.01, "ema50": 1.00, "rsi": 46.0})
        self.assertTrue(rr.pred_rsi45(d))
        d2 = decision(prev={"rsi": 46.0}, cur={"ema20": 1.01, "ema50": 1.00, "rsi": 47.0})
        self.assertFalse(rr.pred_rsi45(d2))

    def test_shrink_route_uses_recomputed_gap(self):
        d = decision(missing="emaUp", cur={"ema20": 0.99, "ema50": 1.00, "rsi": 50.0})
        d["gapShrink"] = True
        self.assertTrue(rr.pred_shrink(d))
        d["gapShrink"] = False
        self.assertFalse(rr.pred_shrink(d))

    def test_gap_shrinking_at(self):
        ordered = [BASE + 300 * k for k in range(5)]
        gap = {ordered[0]: 0.012, ordered[1]: 0.011, ordered[2]: 0.009,
               ordered[3]: 0.007, ordered[4]: 0.005}
        self.assertTrue(rr.gap_shrinking_at(gap, ordered, ordered[4] + 300))
        gap[ordered[3]] = 0.010  # no longer strictly shrinking
        self.assertFalse(rr.gap_shrinking_at(gap, ordered, ordered[4] + 300))
        gap[ordered[3]] = 0.007
        gap[ordered[4]] = -0.001  # latest gap closed: not a shrink route
        self.assertFalse(rr.gap_shrinking_at(gap, ordered, ordered[4] + 300))

    def test_variant_flag_is_judged_on_net(self):
        # +0.8% gross is only +0.2% net: below the +0.3% flag line.
        candles = candles_with_close_at({BASE + 4 * 3600: 1.008})
        weak = rr.analyze([decision(cond_extra={"volumeChangeExceeded": True})
                           for _ in range(31)], candles)
        self.assertNotIn("variant", [f["kind"] for f in weak["flags"]])
        # +1.0% gross is +0.4% net: the novol variant flag fires.
        candles = candles_with_close_at({BASE + 4 * 3600: 1.010})
        strong = rr.analyze([decision(cond_extra={"volumeChangeExceeded": True})
                             for _ in range(31)], candles)
        self.assertIn("variant", [f["kind"] for f in strong["flags"]])


class RegimeTests(unittest.TestCase):
    def test_up_down_range_classification(self):
        up = trending_candles(0.0004)
        self.assertEqual(rr.regime_at(up[4], up[3], BASE), "up")
        down = trending_candles(-0.0004)
        self.assertEqual(rr.regime_at(down[4], down[3], BASE), "down")
        flat = trending_candles(0.0)
        self.assertEqual(rr.regime_at(flat[4], flat[3], BASE), "range")

    def test_unknown_without_24h_of_history(self):
        flat = trending_candles(0.0)
        self.assertEqual(rr.regime_at(flat[4], flat[3], BASE - 3 * 86400 + 3600), "unknown")

    def test_window_filter(self):
        ds = [{"cts": 100}, {"cts": 200}, {"cts": 300}]
        self.assertEqual([d["cts"] for d in rr.filter_window(ds, since=150)], [200, 300])
        self.assertEqual([d["cts"] for d in rr.filter_window(ds, until=200)], [100, 200])
        self.assertEqual([d["cts"] for d in rr.filter_window(ds, 150, 250)], [200])


class VolBandTests(unittest.TestCase):
    def test_atr_bands(self):
        candles = candles_with_close_at({})
        hi = decision(cur={"ema20": 1.01, "ema50": 1.00, "rsi": 50.0, "atr": 0.007})
        lo = decision(cur={"ema20": 1.01, "ema50": 1.00, "rsi": 50.0, "atr": 0.001})
        result = rr.analyze([hi, lo], candles)
        self.assertEqual(result["vols"]["high"]["n"], 1)
        self.assertEqual(result["vols"]["normal"]["n"], 1)


class WorkflowLinkTests(unittest.TestCase):
    def test_review_workflow_autolinks_from_export(self):
        path = os.path.join(HERE, "..", "..", ".github", "workflows",
                            "suiba-paper-review.yml")
        with open(path) as fh:
            source = fh.read()
        self.assertIn("workflow_run", source)
        self.assertIn('"SuiBa public pre-run snapshot export"', source)
        self.assertIn("SUIBA_PAPER_REVIEW_ENABLED", source)


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
