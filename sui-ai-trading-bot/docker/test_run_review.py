#!/usr/bin/env python3
"""Contract tests for docker/run-review.py (stage-1 run review)."""
import contextlib
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("run_review", os.path.join(HERE, "run-review.py"))
rr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rr)

BASE = 1_800_000_000


class MemwalOutboxTests(unittest.TestCase):
    def test_no_credentials_is_a_complete_noop(self):
        with tempfile.NamedTemporaryFile(suffix=".sqlite") as db, \
                patch.dict(os.environ, {}, clear=True):
            rr.enqueue_memwal_lessons(
                db.name, [{"kind": "candidate", "text": "lesson"}], BASE * 1000)
            conn = sqlite3.connect(db.name)
            tables = conn.execute(
                "SELECT name FROM sqlite_master WHERE name='memwal_outbox'").fetchall()
            conn.close()
            self.assertEqual(tables, [])

    def test_enabled_review_queues_only_the_curated_lesson(self):
        env = {
            "SUIBA_MEMWAL_ENABLED": "true",
            "MEMWAL_PRIVATE_KEY": "do-not-store",
            "MEMWAL_ACCOUNT_ID": "account",
            "MEMWAL_RELAYER_URL": "https://relayer.example",
            "MEMWAL_NAMESPACE": "suiba",
        }
        with tempfile.NamedTemporaryFile(suffix=".sqlite") as db, \
                patch.dict(os.environ, env, clear=True):
            rr.enqueue_memwal_lessons(
                db.name, [{"kind": "candidate", "text": "下降局面では待つ"}], BASE * 1000)
            conn = sqlite3.connect(db.name)
            row = conn.execute(
                "SELECT kind,text,attempts FROM memwal_outbox").fetchone()
            conn.close()
            self.assertEqual(row[0], "daily_review")
            self.assertIn("lesson: candidate: 下降局面では待つ", row[1])
            self.assertNotIn("do-not-store", row[1])
            self.assertEqual(row[2], 0)


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
    open_price = dict(close)
    return close, high, low, ordered, ema, gap, open_price


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
    open_price = dict(close)
    return close, high, low, ordered, ema, gap, open_price


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

    def test_liquidation_scene_reproduces_worker_spike_and_24h_axis(self):
        close = {}
        for stamp in range(BASE - 60 * 3600, BASE + 25 * 3600 + 1, 300):
            close[stamp] = 1.0
        close[BASE] = .97
        close[BASE + 24 * 3600] = .98
        ordered = sorted(close)
        candles = (close, dict(close), dict(close), ordered, dict(close), {},
                   dict(close))
        buckets = [{"bucketAt": BASE, "longUsd": 100_000}]
        self.assertEqual(rr.liquidation_spike_events(candles, buckets), [BASE])
        scenes = rr.analyze_scenes([], [], candles, buckets)
        scene = next(item for item in scenes
                     if item["label"] == "liquidation-spike")
        self.assertEqual(scene["net"]["n"], 1)
        self.assertAlmostEqual(
            scene["net"]["mean"], (.98 / .97 - 1) * 100 - .2)

    def test_liquidation_loader_accepts_old_extract_without_table(self):
        with tempfile.NamedTemporaryFile(suffix=".sqlite") as db:
            self.assertEqual(rr.load_liquidation_buckets(db.name), [])

    def test_wick_scenes_use_half_range_boundary_and_four_hour_delta(self):
        stamps = [BASE + offset for offset in range(0, 1801, 300)]
        close = {stamp: 1.0 for stamp in stamps}
        returns = (10, 5, -10, 2, 6, -2, 0)
        close.update({stamp + 14400: 1 + returns[index] / 100
                      for index, stamp in enumerate(stamps)})
        high = dict(close)
        low = dict(close)
        open_price = dict(close)
        # Each event is exactly 0.5; its opposite wick is only 0.25.
        for index in (0, 2):
            open_price[stamps[index]], high[stamps[index]], low[stamps[index]] = (
                1.1, 1.2, .8)
        for index in (3, 5):
            open_price[stamps[index]], high[stamps[index]], low[stamps[index]] = (
                .9, 1.2, .8)
        # Zero range must not become an event.
        open_price[stamps[1]] = high[stamps[1]] = low[stamps[1]] = 1.0
        ordered = sorted(close)
        candles = (close, high, low, ordered, dict(close), {}, open_price)

        scenes = rr.analyze_scenes([], [], candles)
        lower = next(scene for scene in scenes if scene["label"] == "wick-lower")
        upper = next(scene for scene in scenes if scene["label"] == "wick-upper")
        self.assertEqual((lower["net"]["n"], upper["net"]["n"]), (2, 2))
        self.assertAlmostEqual(lower["net"]["mean"], -.6)
        self.assertAlmostEqual(upper["net"]["mean"], -.6)
        lower_baseline = ((10 - .6) + (5 - .6) + (-10 - .6)) / 3
        upper_baseline = ((2 - .6) + (6 - .6) + (-2 - .6)) / 3
        self.assertAlmostEqual(lower["delta"], -.6 - lower_baseline)
        self.assertAlmostEqual(upper["delta"], -.6 - upper_baseline)

    def test_wick_scenes_are_absent_without_samples(self):
        close = {BASE: 1.0, BASE + 14400: 1.1}
        candles = (close, {BASE: 1.0, BASE + 14400: 1.1},
                   {BASE: .9, BASE + 14400: 1.1}, sorted(close),
                   dict(close), {}, {BASE: .9, BASE + 14400: 1.1})
        labels = [scene["label"]
                  for scene in rr.analyze_scenes([], [], candles)]
        self.assertNotIn("wick-lower", labels)
        self.assertNotIn("wick-upper", labels)

    def test_hourly_aggregation_uses_ohlc_and_drops_incomplete_hours(self):
        stamps = [BASE + offset for offset in range(0, 3600, 300)]
        incomplete = [BASE + 3600 + offset for offset in range(0, 3300, 300)]
        ordered = stamps + incomplete
        close = {t: 1 + index / 100 for index, t in enumerate(ordered)}
        high = {t: close[t] + .2 for t in ordered}
        low = {t: close[t] - .2 for t in ordered}
        open_price = {t: close[t] - .1 for t in ordered}
        candles = (close, high, low, ordered, dict(close), {}, open_price)

        result = rr.aggregate_hourly_candles(candles)

        self.assertEqual(result[4], [BASE])
        self.assertEqual(result[0][BASE], open_price[BASE])
        self.assertEqual(result[1][BASE], max(high[t] for t in stamps))
        self.assertEqual(result[2][BASE], min(low[t] for t in stamps))
        self.assertEqual(result[3][BASE], close[stamps[-1]])

    def test_hourly_wick_scene_uses_four_hour_return_and_baseline(self):
        ordered = list(range(BASE, BASE + 7 * 3600, 300))
        close = {t: 1.0 for t in ordered}
        high, low, open_price = dict(close), dict(close), dict(close)
        hour_closes = {4: 1.10, 5: 1.05, 6: .90}
        for hour, value in hour_closes.items():
            close[BASE + (hour + 1) * 3600 - 300] = value
        for hour in (0, 2):
            first = BASE + hour * 3600
            open_price[first], high[first], low[first] = 1.1, 1.2, .8
        candles = (close, high, low, ordered, dict(close), {}, open_price)

        scenes = rr.analyze_scenes([], [], candles)
        scene = next(item for item in scenes
                     if item["label"] == "wick-lower-1h")

        expected_baseline = ((10 - .6) + (5 - .6) + (-10 - .6)) / 3
        self.assertEqual(scene["net"]["n"], 2)
        self.assertAlmostEqual(scene["net"]["mean"], -.6)
        self.assertAlmostEqual(scene["delta"], -.6 - expected_baseline)

    def test_wick_regime_scene_uses_matching_regime_baseline(self):
        past = BASE - 86400
        ordered = list(range(past, BASE + 4 * 3600 + 601, 300))
        close = {t: 1.0 for t in ordered}
        high, low, open_price = dict(close), dict(close), dict(close)
        for stamp in (BASE, BASE + 600):
            open_price[stamp], high[stamp], low[stamp] = 1.1, 1.2, .8
        close[BASE + 4 * 3600] = 1.10
        close[BASE + 4 * 3600 + 300] = 2.00
        close[BASE + 4 * 3600 + 600] = .90
        ema = {t: 1.0 for t in ordered}
        ema[BASE] = ema[BASE + 600] = 1.01
        ema[BASE + 300] = .99
        scenes = []

        rr.add_wick_scenes(scenes, open_price, high, low, close, ordered, "",
                           ema, ordered)
        scene = next(item for item in scenes
                     if item["label"] == "up:wick-lower")

        self.assertEqual(scene["net"]["n"], 2)
        self.assertEqual(scene["overall"]["n"], 2)
        self.assertAlmostEqual(scene["delta"], 0)

    def test_unknown_wick_regime_does_not_create_breakdown(self):
        ordered = [BASE, BASE + 4 * 3600]
        close = {BASE: 1.0, BASE + 4 * 3600: 1.1}
        scenes = []
        rr.add_wick_scenes(
            scenes, {BASE: 1.1, BASE + 4 * 3600: 1.1},
            {BASE: 1.2, BASE + 4 * 3600: 1.1},
            {BASE: .8, BASE + 4 * 3600: 1.1}, close, ordered, "",
            dict(close), ordered)

        labels = [scene["label"] for scene in scenes]
        self.assertIn("wick-lower", labels)
        self.assertFalse(any(label.endswith(":wick-lower") for label in labels))


class ExitGridTests(unittest.TestCase):
    def candles(self, bars):
        candles = candles_with_close_at({})
        close, high, low = candles[:3]
        for offset, hi, lo, final in bars:
            stamp = BASE + offset
            high[stamp], low[stamp], close[stamp] = hi, lo, final
        return candles

    def test_first_touch_tp_and_sl(self):
        tp = rr.simulate_exits([decision()], self.candles([(300, 1.016, 0.999, 1.01)]), 1.5, 1.0)
        self.assertEqual(tp[0]["outcome"], "tp_first")
        self.assertAlmostEqual(tp[0]["net"], 0.9)
        sl = rr.simulate_exits([decision()], self.candles([(300, 1.001, 0.989, 0.99)]), 1.5, 1.0)
        self.assertEqual(sl[0]["outcome"], "sl_first")
        self.assertAlmostEqual(sl[0]["net"], -1.6)

    def test_same_bar_both_is_a_stop_loss(self):
        trades = rr.simulate_exits(
            [decision()], self.candles([(300, 1.016, 0.989, 1.00)]), 1.5, 1.0)
        self.assertEqual(trades[0]["outcome"], "both_same_bar")
        self.assertAlmostEqual(trades[0]["net"], -1.6)

    def test_open_position_skips_later_entry(self):
        ds = [decision(cts=BASE), decision(cts=BASE + 300), decision(cts=BASE + 900)]
        candles = self.candles([(600, 1.016, 0.999, 1.01),
                                (1200, 1.016, 0.999, 1.01)])
        trades = rr.simulate_exits(ds, candles, 1.5, 1.0)
        self.assertEqual([t["entry"]["cts"] for t in trades], [BASE, BASE + 900])

    def test_timeout_uses_close_and_deducts_cost(self):
        candles = self.candles([(86400, 1.011, 0.999, 1.01)])
        trades = rr.simulate_exits([decision()], candles, 1.5, 1.0)
        self.assertEqual(trades[0]["outcome"], "timeout")
        self.assertAlmostEqual(trades[0]["net"], 0.4)

    def test_thin_sets_and_regimes_render_only_data_insufficient(self):
        result = rr.analyze([decision()], candles_with_close_at({}))
        text = rr.render(result, 1, 0, 0, datetime.now(timezone.utc))
        section = text.split("## 学習: 出口グリッド", 1)[1].split("## 局面別の内訳", 1)[0]
        self.assertIn("フル充足: データ不足", section)
        self.assertNotIn("全20セル", section)
        self.assertIn("| フル充足 | 横ばい | データ不足 |", section)
        self.assertNotIn("<details>", section)


class ImprovementProposalTests(unittest.TestCase):
    def result(self, count=29, mark=1.0):
        return rr.analyze([decision(cts=BASE + i * 300) for i in range(count)],
                          candles_with_close_at({BASE + i * 300 + 14400: mark
                                                 for i in range(count)}))

    def test_no_candidates_is_exactly_one_line(self):
        text = rr.render_improvement_proposals(self.result())
        body = text.split("## 改善候補（証拠ゲート通過分のみ）\n\n", 1)[1]
        self.assertEqual(body, "候補なし（全ゲート未達）\n")

    def test_entry_regime_sample_boundary_and_both_bias_directions(self):
        for count, mark, expected in ((29, 1.01, False), (30, 1.01, True),
                                      (30, .99, True)):
            with self.subTest(count=count, mark=mark):
                result = self.result()
                result["learning"]["forward"][3]["range"][4] = {
                    "n": count, "mean": (mark - 1) * 100,
                    "median": (mark - 1) * 100, "pos": 100 if mark > 1 else 0}
                proposals = rr.build_improvement_proposals(result)
                self.assertEqual(any(title.startswith("入口×局面")
                                     for title, _, _ in proposals), expected)

    def test_scene_gate_accepts_30_samples_and_point_three_bias(self):
        result = self.result()
        result["scenes"] = [{"label": "dip-rebound", "net": {
            "n": 30, "mean": .1, "median": .1, "pos": 50},
            "overall": {"n": 100, "mean": .4, "median": .4, "pos": 50},
            "delta": -.3}]
        self.assertTrue(any(title == "場面「dip-rebound」"
                            for title, _, _ in rr.build_improvement_proposals(result)))

    def test_scene_gate_rejects_insufficient_samples(self):
        result = self.result()
        result["scenes"] = [{"label": "dip-rebound", "net": {
            "n": 29, "mean": .1, "median": .1, "pos": 50},
            "overall": {"n": 100, "mean": .4, "median": .4, "pos": 50},
            "delta": -.3}]
        self.assertFalse(any(title.startswith("場面")
                             for title, _, _ in rr.build_improvement_proposals(result)))

    def test_scene_gate_rejects_insufficient_bias(self):
        result = self.result()
        result["scenes"] = [{"label": "dip-rebound", "net": {
            "n": 30, "mean": .11, "median": .11, "pos": 50},
            "overall": {"n": 100, "mean": .4, "median": .4, "pos": 50},
            "delta": -.29}]
        self.assertFalse(any(title.startswith("場面")
                             for title, _, _ in rr.build_improvement_proposals(result)))

    def liquidation_scene(self, count, delta):
        result = self.result()
        result["scenes"] = [{"label": "liquidation-spike", "net": {
            "n": count, "mean": .4 + delta, "median": .4 + delta,
            "pos": 50},
            "overall": {"n": 100, "mean": .4, "median": .4, "pos": 50},
            "delta": delta}]
        return rr.build_improvement_proposals(result)

    def test_liquidation_scene_is_silent_below_30_samples(self):
        self.assertFalse(any(title == "場面「liquidation-spike」"
                             for title, _, _ in self.liquidation_scene(29, .3)))

    def test_liquidation_scene_is_candidate_at_30_samples_with_bias(self):
        self.assertTrue(any(title == "場面「liquidation-spike」"
                            for title, _, _ in self.liquidation_scene(30, -.3)))

    def test_liquidation_scene_is_silent_without_point_three_bias(self):
        self.assertFalse(any(title == "場面「liquidation-spike」"
                             for title, _, _ in self.liquidation_scene(30, .29)))

    def test_exit_grid_gate_uses_existing_cells_and_current_cell(self):
        result = self.result()
        cells = result["learning"]["grids"][3]
        for cell in cells:
            cell.update(n=30, mean=0.0)
        best = next(cell for cell in cells if cell["tp"] == 2.0 and cell["sl"] == 1.5)
        best["mean"] = .3
        proposals = rr.build_improvement_proposals(result)
        self.assertTrue(any("TP +2.0%／SL −1.5%" in action
                            for _, _, action in proposals))
        best["n"] = 29
        self.assertFalse(any(title.startswith("出口設定")
                             for title, _, _ in rr.build_improvement_proposals(result)))

    def test_forecast_gate_requires_second_adjustment_and_extreme_coverage(self):
        result = self.result()
        tally = {"n": 30, "inside": 17, "above": 8, "below": 5,
                 "regimes": {}, "calibrationAdjustments": 2}
        bias = {"n": 30, "horizons": {7200: tally}}
        self.assertTrue(any(title.startswith("予測コーン")
                            for title, _, _ in rr.build_improvement_proposals(result, forecast_bias=bias)))
        tally["calibrationAdjustments"] = 1
        self.assertFalse(any(title.startswith("予測コーン")
                             for title, _, _ in rr.build_improvement_proposals(result, forecast_bias=bias)))

    def test_shadow_gate_reuses_complete_graduation_checks(self):
        result = self.result()
        stat = {"n": 30, "mean": .3, "median": .3, "pos": 50}
        group = {"checks": {key: True for key in
                            ("samples", "mean", "positive", "regimes", "base")},
                 "comparisons": {"ai_only": {"net": {4: stat}}}, "regimeCount": 2}
        shadow = {"versions": {"current": group}}
        self.assertTrue(any(title.startswith("影 AI-only BUY")
                            for title, _, _ in rr.build_improvement_proposals(result, shadow)))
        group["checks"]["samples"] = False
        self.assertFalse(any(title.startswith("影 AI-only BUY")
                             for title, _, _ in rr.build_improvement_proposals(result, shadow)))


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


class ForecastBiasTests(unittest.TestCase):
    def forecast(self, close, steps=24, origin=BASE):
        return {"origin": origin, "up": [1.01] * (steps - 1) + [close],
                "lo": [0.99] * (steps - 1) + [close]}

    def test_final_boundaries_are_inside(self):
        upper = {"origin": BASE, "up": [1.0], "lo": [.99]}
        lower = {"origin": BASE, "up": [1.01], "lo": [1.0]}
        forecasts = [upper, lower]
        result = rr.analyze_forecast_bias(forecasts, candles_with_close_at({}))
        tally = result["horizons"][300]
        self.assertEqual(tally["inside"], 2)
        self.assertEqual((tally["above"], tally["below"]), (0, 0))

    def test_above_below_and_unmatured_are_classified(self):
        above = {"origin": BASE, "up": [0.99], "lo": [0.98]}
        below = {"origin": BASE, "up": [1.02], "lo": [1.01]}
        pending = {"origin": BASE + 90000, "up": [1.01], "lo": [0.99]}
        result = rr.analyze_forecast_bias([above, below, pending], candles_with_close_at({}))
        self.assertEqual(result["n"], 2)
        self.assertEqual(result["horizons"][300]["above"], 1)
        self.assertEqual(result["horizons"][300]["below"], 1)

    def test_thin_horizon_and_regime_are_not_rendered(self):
        forecasts = [self.forecast(1.0) for _ in range(rr.FORECAST_MIN_SAMPLES)]
        bias = rr.analyze_forecast_bias(forecasts, candles_with_close_at({}))
        bias["horizons"][7200]["regimes"]["unknown"]["n"] -= 1
        text = rr.render(rr.analyze([decision()], candles_with_close_at({})), 1, 0, 0,
                         __import__("datetime").datetime.now(__import__("datetime").timezone.utc),
                         forecast_bias=bias)
        self.assertIn("収まり率 100%・上振れ率 0%・下振れ率 0%（n=10）", text)
        self.assertNotIn("<details>", text)
        thin = rr.analyze_forecast_bias(forecasts[:-1], candles_with_close_at({}))
        thin_text = rr.render(rr.analyze([decision()], candles_with_close_at({})), 1, 0, 0,
                              __import__("datetime").datetime.now(__import__("datetime").timezone.utc),
                              forecast_bias=thin)
        self.assertNotIn("収まり率", thin_text)


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


def decision_json(cts, price=1.0):
    return {"action": "WAIT", "evidence": {
        "selectedRule": "NO_SIGNAL", "candleTimestamp": cts,
        "inputs": {"price": price,
                   "current": {"ema20": 1.01, "ema50": 1.00, "rsi": 50.0},
                   "previous": {"rsi": 40.0}},
        "conditions": {"emaUp": True, "rsiRecovery": True,
                       "histogramImproving": True,
                       "latestVolumePositive": True,
                       "previousVolumePositive": True,
                       "volumeChangeExceeded": False}}}


# Two sessions on the real volume: session 1 spans BASE-7200..BASE-3600,
# session 2 spans BASE..BASE+3600; event timestamps are epoch ms.
SESSION1_EVENTS = [((BASE - 7200) * 1000, "BOOT", "PROCESS_RESTART_STOPPED"),
                   ((BASE - 3600) * 1000, "STOP", "PROCESS_SHUTDOWN")]
SESSION2_EVENTS = [(BASE * 1000, "BOOT", "PROCESS_RESTART_STOPPED"),
                   ((BASE + 3600) * 1000, "STOP", "PROCESS_SHUTDOWN")]


def write_review_db(tmp, decision_cts, events):
    db = os.path.join(tmp, "SUI_USDC.sqlite")
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE strategy_decisions (id TEXT, timestamp INTEGER, json TEXT)")
    conn.execute("CREATE TABLE paper_orders (id TEXT, timestamp INTEGER, json TEXT)")
    conn.execute("CREATE TABLE paper_trades (id TEXT, timestamp INTEGER, json TEXT)")
    conn.execute("CREATE TABLE operation_events (id TEXT, timestamp INTEGER, json TEXT)")
    for i, cts in enumerate(decision_cts):
        conn.execute("INSERT INTO strategy_decisions VALUES (?, ?, ?)",
                     (f"d{i}", cts * 1000, json.dumps(decision_json(cts))))
    for i, (ts, kind, code) in enumerate(events):
        conn.execute("INSERT INTO operation_events VALUES (?, ?, ?)",
                     (f"e{i}", ts, json.dumps(
                         {"timestamp": ts, "kind": kind, "code": code})))
    conn.commit()
    conn.close()
    return db


def write_candles_file(tmp):
    raw = []
    t = BASE - 10800
    while t <= BASE + 90000:
        raw.append([t * 1000, 1.0, 1.001, 0.999, 1.0, 1.0])
        t += 300
    path = os.path.join(tmp, "candles.json")
    with open(path, "w") as fh:
        json.dump({"candles": raw}, fh)
    return path


def run_main(argv):
    with contextlib.redirect_stdout(io.StringIO()):
        return rr.main(argv)


class LastSessionWindowTests(unittest.TestCase):
    def test_window_is_last_boot_to_last_shutdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = write_review_db(tmp, [BASE - 5400, BASE + 600],
                                 SESSION1_EVENTS + SESSION2_EVENTS)
            self.assertEqual(rr.load_last_session_window(db), (BASE, BASE + 3600))
            decisions, _, _ = rr.load_decisions(db)
            windowed = rr.filter_window(decisions, *rr.load_last_session_window(db))
            self.assertEqual([d["cts"] for d in windowed], [BASE + 600])

    def test_boot_after_last_shutdown_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            events = SESSION1_EVENTS + SESSION2_EVENTS + [
                ((BASE + 7200) * 1000, "BOOT", "PROCESS_RESTART_STOPPED")]
            db = write_review_db(tmp, [BASE + 600], events)
            self.assertEqual(rr.load_last_session_window(db), (BASE, BASE + 3600))

    def test_missing_shutdown_is_undetermined(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = write_review_db(tmp, [BASE], [(BASE * 1000, "BOOT", "REDACTED")])
            self.assertIsNone(rr.load_last_session_window(db))

    def test_missing_boot_is_undetermined(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = write_review_db(
                tmp, [BASE], [((BASE + 3600) * 1000, "STOP", "PROCESS_SHUTDOWN")])
            self.assertIsNone(rr.load_last_session_window(db))

    def test_main_window_mode_aggregates_only_last_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = write_review_db(tmp, [BASE - 5400, BASE + 600],
                                 SESSION1_EVENTS + SESSION2_EVENTS)
            out = os.path.join(tmp, "windowed.md")
            rc = run_main(["run-review.py", db, "--window", "last-session",
                           "--candles", write_candles_file(tmp), "--out", out])
            self.assertEqual(rc, 0)
            with open(out) as fh:
                text = fh.read()
            self.assertNotIn("特定できませんでした", text)
            self.assertIn("判断: 1 件", text)

    def test_main_window_undetermined_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = write_review_db(tmp, [BASE], [(BASE * 1000, "BOOT", "REDACTED")])
            out = os.path.join(tmp, "windowed.md")
            rc = run_main(["run-review.py", db, "--window", "last-session",
                           "--out", out])
            self.assertEqual(rc, 0)
            with open(out) as fh:
                text = fh.read()
            self.assertEqual(text.splitlines()[0], "直近ランの窓を特定できませんでした")

    def test_main_window_without_decisions_is_undetermined(self):
        with tempfile.TemporaryDirectory() as tmp:
            # The last session's window exists but holds no decisions.
            db = write_review_db(tmp, [BASE - 5400],
                                 SESSION1_EVENTS + SESSION2_EVENTS)
            out = os.path.join(tmp, "windowed.md")
            rc = run_main(["run-review.py", db, "--window", "last-session",
                           "--out", out])
            self.assertEqual(rc, 0)
            with open(out) as fh:
                text = fh.read()
            self.assertEqual(text.splitlines()[0], "直近ランの窓を特定できませんでした")

    def test_main_since_until_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = write_review_db(tmp, [BASE - 5400, BASE + 600],
                                 SESSION1_EVENTS + SESSION2_EVENTS)
            out = os.path.join(tmp, "report.md")
            rc = run_main(["run-review.py", db,
                           "--since", str(BASE - 7200), "--until", str(BASE - 3600),
                           "--candles", write_candles_file(tmp), "--out", out])
            self.assertEqual(rc, 0)
            with open(out) as fh:
                text = fh.read()
            self.assertIn("判断: 1 件", text)


class ShadowReviewTests(unittest.TestCase):
    def public_db(self, tmp, rules, shadows=None):
        path = os.path.join(tmp, "SUI_USDC.sqlite")
        conn = sqlite3.connect(path)
        for table in ("strategy_decisions", "paper_orders", "paper_trades"):
            conn.execute(f"CREATE TABLE {table}(id TEXT PRIMARY KEY,timestamp INTEGER,json TEXT)")
        for i, d in enumerate(rules):
            # Same flat, allowlisted shape as S1's public export. IDs are
            # anonymized joining keys; action deliberately differs from base.
            cid = d.get("cycleId", f"h:{i:064x}")
            ev = {"candleTimestamp": d["cts"], "selectedRule": d["rule"],
                  "inputs": {"price": d["price"], "current": d["cur"], "previous": d["prev"]},
                  "conditions": d["cond"]}
            conn.execute("INSERT INTO strategy_decisions VALUES(?,?,?)", (cid, d["cts"]*1000,
                         json.dumps({"action": d["action"], "evidence": ev})))
        if shadows is not None:
            conn.execute("CREATE TABLE shadow_decisions(id TEXT PRIMARY KEY,timestamp INTEGER,json TEXT)")
            for i, row in enumerate(shadows):
                cid = row.get("cycleId", f"h:{i:064x}")
                conn.execute("INSERT INTO shadow_decisions VALUES(?,?,?)", (cid, row["candleTimestamp"]*1000, json.dumps(row)))
        conn.commit()
        conn.close()
        return path

    def shadow(self, i=0, action="BUY", status="OK", version="shadow-s1-v1", cts=BASE, price=1):
        return {"cycleId": f"h:{i:064x}", "candleTimestamp": cts, "status": status,
                "action": action, "ruleAction": "BUY", "selectedRule": "BUY_SIGNAL",
                "conditionCount": 3, "confidence": .9, "promptVersion": version,
                "usage": {"inputTokens": 10, "outputTokens": 5, "cost": 0},
                "price": price, "rationale": {"refs": [{"type": "book", "key": "bid", "value": 1}]}}

    def review(self, db, candles):
        rules, orders, trades = rr.load_decisions(db)
        result = rr.analyze(rules, candles)
        rows = rr.load_shadow_decisions(db)
        shadow = rr.analyze_shadow(rows, rules, candles)
        from datetime import datetime, timezone
        at = datetime(2026, 11, 14, tzinfo=timezone.utc)
        text = rr.render(result, len(rules), orders, trades, at, shadow)
        return shadow, text, result, rules

    def test_missing_or_empty_shadow_table_is_only_no_records_note(self):
        for shadows in (None, []):
            with self.subTest(shadows=shadows), tempfile.TemporaryDirectory() as tmp:
                db = self.public_db(tmp, [decision()], shadows)
                shadow, text, _, _ = self.review(db, candles_with_close_at({}))
                self.assertEqual(shadow["n"], 0)
                shadow_section = text.split("\n## 改善候補", 1)[0]
                self.assertEqual(shadow_section.split("## AI 影運用", 1)[1].split("\n\n", 1)[1],
                                 "記録なし（影運用は未有効化）\n")

    def test_only_ok_is_scored_and_all_non_ok_statuses_are_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.shadow(i, status=status) for i, status in enumerate(
                ("OK", "ERROR", "SKIPPED_BUDGET", "SKIPPED_DISABLED"))]
            db = self.public_db(tmp, [decision(missing="emaUp") for _ in rows], rows)
            shadow, text, _, _ = self.review(db, candles_with_close_at({BASE+3600: 1.02, BASE+14400: 1.03, BASE+86400: 1.04}))
            group = shadow["versions"]["shadow-s1-v1"]
            self.assertEqual(group["buy"]["n"], 1)
            for h, gross in ((1, 2), (4, 3), (24, 4)):
                stat = group["buy"]["h"][h]
                self.assertAlmostEqual(stat["mean"], gross)
                self.assertAlmostEqual(stat["median"], gross)
                self.assertEqual(stat["pos"], 100)
                self.assertAlmostEqual(group["buy"]["net"][h]["mean"], gross-.6)
            self.assertEqual(group["buy"]["touches"], {"tp_first": 1})
            for status in ("ERROR", "SKIPPED_BUDGET", "SKIPPED_DISABLED"):
                self.assertEqual(shadow["statuses"][status], 1)
                self.assertIn(status, text)
            self.assertIn("スリッページ・不約定・ProfitGuard", text)

    def test_four_way_join_uses_cycle_id_and_base_not_copied_action(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Same timestamps and intentionally misleading ruleAction. Row
            # order cannot establish the join; only anonymized cycle IDs can.
            rules = [decision(missing="emaUp"), decision(), decision(), decision(missing="emaUp")]
            rows = [self.shadow(2), self.shadow(0), self.shadow(3, "WAIT"), self.shadow(1, "WAIT")]
            db = self.public_db(tmp, rules, rows)
            shadow, text, _, _ = self.review(db, candles_with_close_at({BASE+14400:1.02}))
            groups = shadow["versions"]["shadow-s1-v1"]["comparisons"]
            for key in ("ai_only", "rule_only", "both_buy", "both_wait"):
                self.assertEqual(groups[key]["n"], 1)
                self.assertAlmostEqual(groups[key]["net"][4]["mean"], 1.4)
            self.assertIn("| 影BUY（shadow-s1-v1） | 2 |", text)

    def test_versions_are_not_pooled_even_if_together_they_reach_30(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.shadow(i, version="shadow-s1-v1" if i<15 else "shadow-s1-v2") for i in range(30)]
            db = self.public_db(tmp, [decision(missing="emaUp") for _ in rows], rows)
            shadow, text, _, _ = self.review(db, candles_with_close_at({BASE+14400:1.02}))
            self.assertEqual(len(shadow["versions"]), 2)
            for group in shadow["versions"].values():
                self.assertEqual(group["buy"]["n"], 15)
                self.assertFalse(group["checks"]["samples"])
            self.assertEqual(text.count("### promptVersion:"), 2)
            self.assertEqual(text.count("| 影BUY（"), 2)

    def test_veto_counterfactual_negative_mean_reports_avoided_loss_for_latest_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            c1, c2 = BASE, BASE + 300
            rules = [decision(cts=c1), decision(cts=c2)]
            rows = [self.shadow(0, action="WAIT", version="older", cts=c1),
                    self.shadow(1, action="WAIT", version="latest", cts=c2)]
            db = self.public_db(tmp, rules, rows)
            _, text, _, _ = self.review(db, candles_with_close_at({c1 + 14400: .98, c2 + 14400: .98}))
            block = text.split("### 影が反対した買い（フィルタ反事実）", 1)[1]
            self.assertEqual(text.count("### 影が反対した買い（フィルタ反事実）"), 1)
            self.assertIn("見送っていれば合計 2.60%pt の損失を回避", block)
            self.assertIn("判定は +4h 採点可能 n が 30 に達するまで保留", block)

    def test_veto_counterfactual_positive_mean_reports_missed_profit(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = self.public_db(tmp, [decision()], [self.shadow(action="WAIT")])
            _, text, _, _ = self.review(db, candles_with_close_at({BASE + 14400: 1.02}))
            self.assertIn("見送ると合計 1.40%pt の利益を取りこぼし", text)

    def test_veto_counterfactual_without_scorable_sample_keeps_placeholder(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = self.public_db(tmp, [decision()], [self.shadow(action="WAIT")])
            candles = candles_with_close_at({})
            del candles[0][BASE + 14400]
            _, text, _, _ = self.review(db, candles)
            block = text.split("### 影が反対した買い（フィルタ反事実）", 1)[1]
            self.assertIn("正味 +4h: —（採点可能な標本なし）", block)
            self.assertIn("合計の反事実: —（採点可能な標本なし）", block)
            self.assertIn("通過側（両者 BUY）: 総件数 0 件 / +4h 採点可能 n=0 / 正味 +4h 平均 —（採点可能な標本なし）", block)

    def test_graduation_all_checks_and_same_period_base_includes_untriggered_cycles(self):
        with tempfile.TemporaryDirectory() as tmp:
            c1, c2 = BASE, BASE+86400
            rules = [decision(missing="emaUp", cts=c1 if i<15 else c2) for i in range(30)]
            # One untriggered base inside the version span, one outside it.
            rules += [decision(cts=c1+300), decision(cts=c1-300, price=.01)]
            rows = [self.shadow(i, cts=c1 if i<15 else c2) for i in range(30)]
            db = self.public_db(tmp, rules, rows)
            candles = candles_with_close_at({c1+14400:1.02})
            close, high, low, ordered, ema, _, _ = candles
            # Sufficient history for two real mechanical regime tags; the
            # second candidate group is sideways, the first is upward.
            earlier = c1-86400
            close[earlier]=1; high[earlier]=1; low[earlier]=1; ema[earlier]=1
            ordered.insert(0, earlier)
            ema[c1]=1.02; ema[c2]=1.02
            close[c2+14400]=1.02; high[c2+14400]=1.02; low[c2+14400]=1.02
            ordered.append(c2+14400)
            shadow, text, _, _ = self.review(db, candles)
            group = shadow["versions"]["shadow-s1-v1"]
            self.assertTrue(all(group["checks"].values()), group["checks"])
            self.assertEqual(group["base"]["n"], 1)
            self.assertEqual(group["regimeCount"], 2)
            self.assertEqual(text.count("- [x]"), 5)
            self.assertIn("全条件充足", text)
            self.assertIn("何も自動で変えない", text)

    def test_unmatured_and_unknown_regimes_cannot_satisfy_graduation(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.shadow(i) for i in range(30)]
            db = self.public_db(tmp, [decision(missing="emaUp") for _ in rows], rows)
            shadow, text, _, _ = self.review(db, candles_with_close_at({}))
            group=shadow["versions"]["shadow-s1-v1"]
            self.assertTrue(group["checks"]["samples"])
            self.assertFalse(group["checks"]["positive"])
            self.assertFalse(group["checks"]["mean"])
            self.assertFalse(group["checks"]["regimes"])
            self.assertFalse(group["checks"]["base"])
            self.assertIn("未充足", text)
            # Remove the +4h candle: sample count also fails, never zero-fills.
            candles=candles_with_close_at({}); del candles[0][BASE+14400]
            shadow, _, _, _=self.review(db,candles)
            self.assertFalse(shadow["versions"]["shadow-s1-v1"]["checks"]["samples"])

    def test_same_cycle_atr_bands_and_missing_join_are_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            rules=[decision(cur={"atr":.0065}),decision(cur={"atr":.00649}),decision(cur={"rsi":40})]
            rows=[self.shadow(i) for i in range(4)]
            db=self.public_db(tmp,rules,rows)
            shadow, text, _, _=self.review(db,candles_with_close_at({}))
            group=shadow["versions"]["shadow-s1-v1"]
            self.assertEqual([group["vols"][v]["n"] for v in ("high","normal","unknown")],[1,1,1])
            self.assertEqual(group["invalid"],1)
            self.assertIn("結合不可／入力不整合 1",text)

    def test_touch_paths_share_exact_existing_implementation(self):
        for kind in ("tp_first","sl_first","both_same_bar","neither"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                candles=candles_with_close_at({})
                if kind in ("tp_first","both_same_bar"): candles[1][BASE+300]=1.02
                if kind in ("sl_first","both_same_bar"): candles[2][BASE+300]=.98
                db=self.public_db(tmp,[decision(missing="emaUp")],[self.shadow()])
                shadow, _, existing, _=self.review(db,candles)
                self.assertEqual(shadow["versions"]["shadow-s1-v1"]["buy"]["touches"],{kind:1})
                self.assertEqual(existing["touches"],{kind:1})

    def test_existing_output_and_results_are_identical_with_or_without_shadow(self):
        from datetime import datetime,timezone
        import hashlib
        at=datetime(2026,11,14,tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            db=self.public_db(tmp,[decision(missing="emaUp"),decision()],[self.shadow()])
            shadow,text,result,rules=self.review(db,candles_with_close_at({BASE+14400:1.02}))
            legacy=rr.render(result,len(rules),0,0,at)
            existing=text.split("\n## AI 影運用",1)[0]
            existing="\n".join(line for line in existing.split("\n") if not line.startswith("| 影BUY（"))
            legacy_existing = legacy.split("\n## 改善候補", 1)[0]
            self.assertEqual(existing, legacy_existing)
            conn=sqlite3.connect(db); conn.execute("DELETE FROM shadow_decisions"); conn.commit(); conn.close()
            _,empty_text,empty_result,_=self.review(db,candles_with_close_at({BASE+14400:1.02}))
            self.assertEqual(result,empty_result)
            self.assertEqual(empty_text.split("\n## AI 影運用",1)[0], legacy_existing)
            # Main report contract, including the observational learning block.
            self.assertEqual(hashlib.sha256(legacy_existing.encode()).hexdigest(), "a52e30f6b594c9f1f8e178e981ab6ee0b03aad3c300a39315b6b743dfc8d0cc9")

    def test_real_s1_sanitize_and_indexer_path_feed_shadow_without_changing_existing_fetch(self):
        from unittest.mock import patch
        export_spec=importlib.util.spec_from_file_location("shadow_export",os.path.join(HERE,"../deploy/paper-check/export_snapshot.py"))
        export=importlib.util.module_from_spec(export_spec); export_spec.loader.exec_module(export)
        with tempfile.TemporaryDirectory() as tmp:
            raw=self.shadow(); raw.update({"cycleId":"same-cycle","model":"SECRET_MODEL", "prompt":"SECRET_PROMPT",
                "rationale":{"text":"SECRET_TEXT","refs":[]},
                "snapshot":{"evidence":{"inputs":{"price":1}},"settings":{"secret":"SECRET_KEY"},"candles":["SECRET_CANDLES"]}})
            public=export.sanitize("shadow_decisions",raw)
            rule=decision(missing="emaUp"); rule["cycleId"]=export.identifier("same-cycle")
            db=self.public_db(tmp,[rule],[public])
            path=write_candles_file(tmp)
            with open(path,encoding="utf-8") as fh: candles=json.load(fh)
            with patch.object(rr,"fetch_candles",return_value=candles["candles"]) as fetch, contextlib.redirect_stdout(io.StringIO()) as captured:
                self.assertEqual(rr.main(["run-review.py",db]),0)
            fetch.assert_called_once()
            self.assertEqual(len(fetch.call_args.args[0]),1)  # original rule inputs only
            text=captured.getvalue()
            self.assertIn("| AI のみ BUY | 1 |",text)
            self.assertNotIn("SECRET_",text)

    def test_same_period_base_can_block_graduation(self):
        with tempfile.TemporaryDirectory() as tmp:
            rules=[decision(missing="emaUp") for _ in range(30)]+[decision(price=.98)]
            rows=[self.shadow(i) for i in range(30)]
            db=self.public_db(tmp,rules,rows)
            shadow,_,_,_=self.review(db,candles_with_close_at({BASE+14400:1.02}))
            g=shadow["versions"]["shadow-s1-v1"]
            self.assertTrue(g["checks"]["mean"])
            self.assertFalse(g["checks"]["base"])
            self.assertGreater(g["base"]["net"][4]["mean"],g["comparisons"]["ai_only"]["net"][4]["mean"])

    def test_cli_applies_time_window_to_shadow_and_preserves_no_record_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            db=self.public_db(tmp,[decision(cts=BASE),decision(cts=BASE+3600)],
                              [self.shadow(0,cts=BASE),self.shadow(1,cts=BASE+3600,status="ERROR")])
            path=write_candles_file(tmp)
            out=os.path.join(tmp,"report.md")
            self.assertEqual(run_main(["run-review.py",db,"--candles",path,"--since",str(BASE+3600),"--until",str(BASE+3600),"--out",out]),0)
            with open(out,encoding="utf-8") as fh: text=fh.read()
            self.assertIn("記録 1 件：OK 0 / ERROR 1",text)


if __name__ == "__main__":
    unittest.main()
