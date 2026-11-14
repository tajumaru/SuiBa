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
from datetime import datetime, timezone

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
                self.assertEqual(text.split("## AI 影運用", 1)[1].split("\n\n", 1)[1],
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

    def test_graduation_all_checks_and_same_period_base_includes_untriggered_cycles(self):
        with tempfile.TemporaryDirectory() as tmp:
            c1, c2 = BASE, BASE+86400
            rules = [decision(missing="emaUp", cts=c1 if i<15 else c2) for i in range(30)]
            # One untriggered base inside the version span, one outside it.
            rules += [decision(cts=c1+300), decision(cts=c1-300, price=.01)]
            rows = [self.shadow(i, cts=c1 if i<15 else c2) for i in range(30)]
            db = self.public_db(tmp, rules, rows)
            candles = candles_with_close_at({c1+14400:1.02})
            close, high, low, ordered, ema, _ = candles
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
            self.assertEqual(existing,legacy)
            conn=sqlite3.connect(db); conn.execute("DELETE FROM shadow_decisions"); conn.commit(); conn.close()
            _,empty_text,empty_result,_=self.review(db,candles_with_close_at({BASE+14400:1.02}))
            self.assertEqual(result,empty_result)
            self.assertEqual(empty_text.split("\n## AI 影運用",1)[0],legacy)
            # Main report contract, including the observational learning block.
            self.assertEqual(hashlib.sha256(legacy.encode()).hexdigest(), "faff8b582b5537b8751c2e209a7182a6d72158e2e46aaff848216bb1a2a03b50")

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
