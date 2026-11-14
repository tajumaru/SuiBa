#!/usr/bin/env python3
"""SuiBa run review (stage 1): counterfactual analysis of recorded decisions.

Reads an exported SUI_USDC.sqlite (strategy_decisions with evidence JSON)
and DeepBook Indexer 5m candles, then measures what would have happened
after each decision: forward returns at +1h/+4h/+24h bucketed by how many
of the core BUY conditions were met, a marginal analysis for decisions
that missed a BUY by exactly one condition, virtual TP/SL first-touch
counts for the near-miss bucket, and threshold-based candidate flags.

The report is evidence only: it never changes trading rules. A flag means
"this relaxation/protection has accumulated enough samples to be worth a
human decision", nothing more.

Usage: run-review.py <SUI_USDC.sqlite> [--candles candles.json] [--out report.md]
       [--since T] [--until T] [--window last-session]
Without --candles, candles are fetched from the public Indexer.
--window last-session derives the --since/--until window from the DB's
own operation events (the most recent run's BOOT..PROCESS_SHUTDOWN).
"""
import json
import math
import sqlite3
import statistics
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

INDEXER = "https://deepbook-indexer.mainnet.mystenlabs.com/ohclv/SUI_USDC"
with (Path(__file__).resolve().parents[1] / "packages/shared/src/shadow-comparison.json").open(encoding="utf-8") as fh:
    SHADOW_COMPARISON = json.load(fh)
CORE = SHADOW_COMPARISON["coreConditions"]
HORIZONS = (1, 4, 24)
FORECAST_MIN_SAMPLES = 10
# Candidate-flag thresholds (v1 heuristics, see docs/RUN_REVIEW_JA.md).
# Flags are judged on NET returns (after the round-trip cost below).
FLAG_MIN_SAMPLES = 30
FLAG_MIN_MEAN_4H = 0.30   # percent
FLAG_MIN_POS_4H = 50.0    # percent
CAUTION_MAX_MEAN_4H = -0.30
# Round-trip cost: the bot's own fee setting (feeRate default 0.003 per
# side in packages/shared). Slippage is NOT deducted, so real costs are
# higher; exports omit the live settings, hence the default is used.
FEE_RATE_PER_SIDE = 0.003
ROUND_TRIP_COST_PCT = 2 * FEE_RATE_PER_SIDE * 100  # 0.6%
TAKE_PROFIT_PCT = 1.5
STOP_LOSS_PCT = 1.0
EXIT_TPS = (1.0, 1.5, 2.0, 2.5, 3.0)
EXIT_SLS = (0.7, 1.0, 1.5, 2.0)
EXIT_HOURS = 24
LEARNING_MIN_SAMPLES = 5


def compute_limit(decisions):
    """Candle count covering the decision span (cts is epoch seconds)."""
    if not decisions:
        return 2000
    span_s = decisions[-1]["cts"] - decisions[0]["cts"]
    return min(10000, int(span_s / 300) + 2000)


def fetch_candles(decisions):
    url = f"{INDEXER}?interval=5m&limit={compute_limit(decisions)}"
    req = urllib.request.Request(url, headers={"User-Agent": "suiba-run-review/1"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)["candles"]


def load_candles(raw):
    close, high, low = {}, {}, {}
    for c in raw:
        t = int(c[0]) // 1000
        high[t], low[t], close[t] = float(c[2]), float(c[3]), float(c[4])
    ordered = sorted(close)
    # EMA50 over the close series, for the regime tag.
    ema, value = {}, None
    alpha = 2 / 51
    for t in ordered:
        value = close[t] if value is None else value + alpha * (close[t] - value)
        ema[t] = value
    # Shared-implementation EMA20/EMA50 (SMA seed), for the gap series used
    # by the shrink variant: gap = (ema50 - ema20) / close per candle.
    closes = [close[t] for t in ordered]
    e20 = shared_ema(closes, 20)
    e50 = shared_ema(closes, 50)
    gap = {}
    for idx, t in enumerate(ordered):
        gap[t] = None if e20[idx] is None or e50[idx] is None \
            else (e50[idx] - e20[idx]) / closes[idx]
    return close, high, low, ordered, ema, gap


def shared_ema(values, period):
    """packages/indicators ema(): SMA seed at period-1, then 2/(n+1)."""
    out, value = [], 0.0
    for i, x in enumerate(values):
        if i < period:
            value += x
        if i < period - 1:
            out.append(None)
        elif i == period - 1:
            value /= period
            out.append(value)
        else:
            value += (x - value) * 2 / (period + 1)
            out.append(value)
    return out


def gap_shrinking_at(gap, ordered, cts, count=3):
    """strategy-engine emaGapShrinking over the candles ending at cts-300:
    the gap strictly shrinks across the last `count` candles and the
    latest gap is still open (> 0). Fails closed on any missing value."""
    import bisect
    i = bisect.bisect_right(ordered, cts - 300) - 1
    if i < count - 1:
        return False
    window = [gap[ordered[i - count + 1 + k]] for k in range(count)]
    if any(g is None for g in window):
        return False
    strictly = all(window[k + 1] < window[k] for k in range(count - 1))
    return strictly and window[-1] > 0


def regime_at(ema, ordered, cts):
    """Mechanical regime tag: EMA50 slope over the trailing 24h.

    up: >= +0.5%, down: <= -0.5%, otherwise range. ``unknown`` when the
    fetched series does not reach 24h back from the decision.
    """
    import bisect
    i = bisect.bisect_right(ordered, cts) - 1
    j = bisect.bisect_right(ordered, cts - 86400) - 1
    if i < 0 or j < 0 or ordered[j] > cts - 86400 + 900:
        return "unknown"
    slope = (ema[ordered[i]] / ema[ordered[j]] - 1) * 100
    if slope >= 0.5:
        return "up"
    if slope <= -0.5:
        return "down"
    return "range"


def filter_window(decisions, since=None, until=None):
    return [d for d in decisions
            if (since is None or d["cts"] >= since)
            and (until is None or d["cts"] <= until)]


# First line is the contract the review workflow renders as-is: when the
# window cannot be derived, this note is the whole windowed section.
UNDETERMINED_WINDOW = (
    "直近ランの窓を特定できませんでした\n"
    "\n"
    "- export 内の開始（BOOT）／終了（STOP／PROCESS_SHUTDOWN）の記録の組が"
    "見つからないか、窓の中に判断記録が無いため、この窓の集計はありません。\n")


def load_last_session_window(db_path):
    """Epoch-second (start, end) of the most recent run's active lifetime.

    The worker writes a BOOT operation event at every process boot and
    STOP/PROCESS_SHUTDOWN as its final event, and the paper-check
    lifecycle starts the container exactly once per run, so the last
    BOOT at or before the last PROCESS_SHUTDOWN brackets one run.
    (A BOOT after the last shutdown belongs to a still-open session
    and is ignored.) Event timestamps are epoch ms; the returned
    window is in the epoch seconds that --since/--until and the
    decisions' candle timestamps use. None when the pair cannot be
    found, or the events table is absent or unreadable.
    """
    try:
        conn = sqlite3.connect(db_path)
        try:
            rows = conn.execute(
                "SELECT timestamp, json FROM operation_events"
                " ORDER BY timestamp").fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    events = []
    for ts, js in rows:
        try:
            value = json.loads(js)
        except (TypeError, ValueError):
            continue
        events.append((ts, value.get("kind"), value.get("code")))
    end = None
    for stamp, kind, code in reversed(events):
        if kind == "STOP" and code == "PROCESS_SHUTDOWN":
            end = stamp
            break
    if end is None:
        return None
    for stamp, kind, code in reversed(events):
        if stamp <= end and kind == "BOOT":
            return stamp // 1000, end // 1000
    return None


def vol_ok(d):
    c = d["cond"]
    gate = SHADOW_COMPARISON["volumeGate"]
    return bool(all(c.get(k) is True for k in gate["requiredTrue"])
                and all(c.get(k) is not True for k in gate["requiredFalse"]))


def pred_base(d):
    """The live BUY rule for a flat position (strategy-engine)."""
    return vol_ok(d) and all(d["cond"].get(k) for k in CORE)


def pred_novol(d):
    """Variant: the BUY rule without the volume gate."""
    return all(d["cond"].get(k) for k in CORE)


def pred_rsi45(d):
    """Variant: RSI recovery across 45 (the hard preset's line)."""
    p, i = d["prev"].get("rsi"), d["cur"].get("rsi")
    return (vol_ok(d) and d["cond"].get("emaUp")
            and d["cond"].get("histogramImproving")
            and p is not None and i is not None and p <= 45 and i > 45)


def pred_shrink(d):
    """Variant: EMA route via a shrinking gap (recomputed from candles,
    independent of the live emaGapShrinkEnabled setting)."""
    cur = d["cur"]
    ema_above = (cur.get("ema20") is not None and cur.get("ema50") is not None
                 and cur["ema20"] > cur["ema50"])
    return (vol_ok(d) and d["cond"].get("rsiRecovery")
            and d["cond"].get("histogramImproving")
            and (ema_above or d.get("gapShrink", False)))


VARIANTS = [
    ("base", "現行ルール", pred_base),
    ("novol", "出来高ゲートなし", pred_novol),
    ("rsi45", "RSI回復ライン45（ハード相当）", pred_rsi45),
    ("shrink", "EMA差縮小ルート（3本・再計算）", pred_shrink),
]


def summarize_net(values):
    return summarize([None if v is None else v - ROUND_TRIP_COST_PCT
                      for v in values])


def load_decisions(db_path):
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT id, json FROM strategy_decisions ORDER BY timestamp").fetchall()
        orders = conn.execute("SELECT COUNT(*) FROM paper_orders").fetchone()[0]
        trades = conn.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0]
    finally:
        conn.close()
    decisions = []
    for cycle_id, js in rows:
        d = json.loads(js)
        ev = d.get("evidence") or {}
        cond = ev.get("conditions") or {}
        inp = ev.get("inputs") or {}
        decisions.append({
            "cycleId": cycle_id,
            "action": d.get("action"), "rule": ev.get("selectedRule"),
            "cts": ev.get("candleTimestamp"), "price": inp.get("price"),
            "cond": cond, "met": sum(1 for k in CORE if cond.get(k)),
            "cur": inp.get("current") or {}, "prev": inp.get("previous") or {},
        })
    return decisions, orders, trades


def load_forecasts(db_path):
    """Load the archived cone once; older exports may omit its table."""
    conn = sqlite3.connect(db_path)
    try:
        if not conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='forecast_records'"
        ).fetchone():
            return []
        rows = conn.execute(
            "SELECT json FROM forecast_records ORDER BY timestamp, id").fetchall()
    finally:
        conn.close()
    forecasts = []
    for (raw,) in rows:
        try:
            value = json.loads(raw)
            origin, upper, lower = value["origin"], value["up"], value["lo"]
            if (type(origin) is not int or not upper or len(upper) != len(lower)
                    or any(type(x) not in (int, float) or not math.isfinite(x)
                           for x in upper + lower)):
                continue
            forecasts.append({"origin": origin, "up": upper, "lo": lower})
        except (KeyError, TypeError, ValueError):
            continue
    return forecasts


def analyze_forecast_bias(forecasts, candles, timeframe=300):
    """Classify each closed forecast at its final horizon point.

    Bounds are inclusive, matching the worker's forecast score. Requiring a
    later candle ensures the final horizon candle has closed.
    """
    close, _, _, ordered, ema, _ = candles
    latest = ordered[-1] if ordered else None
    rows = []
    for forecast in forecasts:
        steps = len(forecast["up"])
        final_at = forecast["origin"] + (steps - 1) * timeframe
        if latest is None or latest <= final_at or final_at not in close:
            continue
        actual = close[final_at]
        upper, lower = forecast["up"][-1], forecast["lo"][-1]
        outcome = "above" if actual > upper else "below" if actual < lower else "inside"
        rows.append({
            "horizon": steps * timeframe,
            "regime": regime_at(ema, ordered, forecast["origin"]),
            "outcome": outcome,
        })

    def tally(group):
        counts = Counter(row["outcome"] for row in group)
        return {"n": len(group), "inside": counts["inside"],
                "above": counts["above"], "below": counts["below"]}

    horizons = {}
    for horizon in sorted({row["horizon"] for row in rows}):
        group = [row for row in rows if row["horizon"] == horizon]
        horizons[horizon] = {
            **tally(group),
            "regimes": {regime: tally([row for row in group if row["regime"] == regime])
                        for regime in ("up", "down", "range", "unknown")
                        if any(row["regime"] == regime for row in group)},
        }
    return {"n": len(rows), "horizons": horizons}


def summarize(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {"n": len(values), "mean": statistics.mean(values),
            "median": statistics.median(values),
            "pos": sum(1 for v in values if v > 0) / len(values) * 100}


def forward_return(d, hours, candles):
    close = candles[0]
    if d["cts"] is None or not d["price"]:
        return None
    p = close.get(d["cts"] + hours * 3600)
    return None if p is None else (p / d["price"] - 1) * 100


def virtual_touch(d, candles, hours=24):
    _, high, low, ordered, _, _ = candles
    up, dn = d["price"] * 1.015, d["price"] * 0.99
    for t in ordered:
        if t <= d["cts"]:
            continue
        if t > d["cts"] + hours * 3600:
            break
        if low[t] <= dn and high[t] >= up:
            return "both_same_bar"
        if high[t] >= up:
            return "tp_first"
        if low[t] <= dn:
            return "sl_first"
    return "neither"


def simulate_exits(decisions, candles, tp_pct, sl_pct, hours=EXIT_HOURS):
    """Sequential single-position first-touch simulation."""
    close, high, low, ordered, _, _ = candles
    candidates = sorted((d for d in decisions if d.get("cts") is not None and d.get("price")),
                        key=lambda d: d["cts"])
    trades, busy_until = [], None
    for d in candidates:
        if busy_until is not None and d["cts"] < busy_until:
            continue
        deadline = d["cts"] + hours * 3600
        up = d["price"] * (1 + tp_pct / 100)
        dn = d["price"] * (1 - sl_pct / 100)
        outcome = None
        for t in ordered:
            if t <= d["cts"]:
                continue
            if t > deadline:
                break
            hit_tp, hit_sl = high[t] >= up, low[t] <= dn
            if hit_sl:
                outcome = (t, "both_same_bar" if hit_tp else "sl_first",
                           -sl_pct - ROUND_TRIP_COST_PCT)
                break
            if hit_tp:
                outcome = (t, "tp_first", tp_pct - ROUND_TRIP_COST_PCT)
                break
        if outcome is None and deadline in close:
            outcome = (deadline, "timeout",
                       (close[deadline] / d["price"] - 1) * 100 - ROUND_TRIP_COST_PCT)
        if outcome is None:
            busy_until = deadline
            continue
        exit_cts, kind, net = outcome
        trades.append({"entry": d, "exitCts": exit_cts, "outcome": kind, "net": net})
        busy_until = exit_cts
    return trades


def summarize_trades(trades):
    if not trades:
        return {"n": 0, "win": 0.0, "mean": 0.0, "total": 0.0, "outcomes": Counter()}
    nets = [t["net"] for t in trades]
    return {"n": len(trades), "win": sum(v > 0 for v in nets) / len(nets) * 100,
            "mean": statistics.mean(nets), "total": sum(nets),
            "outcomes": Counter(t["outcome"] for t in trades)}


def fmt_trade_stat(cell):
    return (f"n={cell['n']}、勝率 {cell['win']:.1f}%、平均 {cell['mean']:+.2f}%、"
            f"合計 {cell['total']:+.1f}%")


def render_learning(learning):
    labels = {3: "フル充足", 2: "あと1つ"}
    regime_labels = {"up": "上昇", "down": "下降", "range": "横ばい", "unknown": "不明"}
    lines = ["", "## 学習: 出口グリッド（逐次模擬）", "",
             f"24時間、往復コスト {ROUND_TRIP_COST_PCT:.1f}% 控除後。基準セルは export にライブ設定が"
             f"含まれないため共有既定値（利確 +{TAKE_PROFIT_PCT:.1f}%／損切り −{STOP_LOSS_PCT:.1f}%）を使用。"
             "同一5分足で両方に触れた場合は損切り扱い。", ""]
    for met in (3, 2):
        cells = learning["grids"][met]
        baseline = next(c for c in cells if c["tp"] == TAKE_PROFIT_PCT and c["sl"] == STOP_LOSS_PCT)
        if baseline["n"] < LEARNING_MIN_SAMPLES:
            lines.append(f"- {labels[met]}: データ不足")
            continue
        best, worst = max(cells, key=lambda c: c["mean"]), min(cells, key=lambda c: c["mean"])
        for name, cell in (("基準", baseline), ("最良", best), ("最悪", worst)):
            lines.append(f"- {labels[met]} {name}（TP +{cell['tp']:.1f}%／SL −{cell['sl']:.1f}%）: "
                         f"{fmt_trade_stat(cell)}")
        lines += ["", f"<details><summary>{labels[met]}の全20セル</summary>", "",
                  "| TP | SL | n | 勝率 | 平均 | 合計 | TP/SL/同足/時間切れ |",
                  "|---:|---:|---:|---:|---:|---:|---:|"]
        for cell in cells:
            o = cell["outcomes"]
            lines.append(f"| +{cell['tp']:.1f}% | −{cell['sl']:.1f}% | {cell['n']} | {cell['win']:.1f}% | "
                         f"{cell['mean']:+.2f}% | {cell['total']:+.1f}% | "
                         f"{o.get('tp_first', 0)}/{o.get('sl_first', 0)}/{o.get('both_same_bar', 0)}/{o.get('timeout', 0)} |")
        lines += ["", "</details>", ""]

    lines += ["", "## 学習: 入口×局面", "",
              "信号単位の前方向リターン（往復コスト控除後。逐次化なし）。", "",
              "| 集合 | 局面 | +4h 平均 | プラス率 |", "|---|---|---:|---:|"]
    for met in (3, 2):
        for regime in ("up", "down", "range"):
            stat = learning["forward"][met][regime][4]
            if not stat or stat["n"] < LEARNING_MIN_SAMPLES:
                value = "データ不足"
                pos = "—"
            else:
                value, pos = f"{stat['mean']:+.2f}%（n={stat['n']}）", f"{stat['pos']:.1f}%"
            lines.append(f"| {labels[met]} | {regime_labels[regime]} | {value} | {pos} |")
    detail_has_data = any(
        (stat := learning["forward"][met][regime][24])
        and stat["n"] >= LEARNING_MIN_SAMPLES
        for met in (3, 2)
        for regime in ("up", "down", "range")
    ) or any(
        learning["baseline"][met][key]["n"] >= LEARNING_MIN_SAMPLES
        for met in (3, 2)
        for key in ("all", "withoutDown")
    ) or any(
        learning["baseline"][met]["byRegime"][regime]["n"] >= LEARNING_MIN_SAMPLES
        for met in (3, 2)
        for regime in ("up", "down", "range")
    )
    if not detail_has_data:
        return lines

    lines += ["", "<details><summary>+24h と基準出口の逐次模擬</summary>", ""]
    for met in (3, 2):
        lines.append(f"### {labels[met]}")
        for regime in ("up", "down", "range"):
            stat = learning["forward"][met][regime][24]
            fwd = "データ不足" if not stat or stat["n"] < LEARNING_MIN_SAMPLES else \
                f"平均 {stat['mean']:+.2f}%、プラス率 {stat['pos']:.1f}%（n={stat['n']}）"
            seq = learning["baseline"][met]["byRegime"][regime]
            seq_text = "データ不足" if seq["n"] < LEARNING_MIN_SAMPLES else fmt_trade_stat(seq)
            lines.append(f"- {regime_labels[regime]}: 正味 +24h {fwd}／逐次 {seq_text}")
        base = learning["baseline"][met]
        all_text = "データ不足" if base["all"]["n"] < LEARNING_MIN_SAMPLES else fmt_trade_stat(base["all"])
        no_down = base["withoutDown"]
        no_down_text = "データ不足" if no_down["n"] < LEARNING_MIN_SAMPLES else fmt_trade_stat(no_down)
        lines.append(f"- 全入口: {all_text}／下降入口を除外: {no_down_text}")
    lines += ["", "</details>"]
    return lines


def analyze_learning(decisions, candles):
    sets = {3: [d for d in decisions if d["met"] == 3],
            2: [d for d in decisions if d["met"] == 2]}
    grids = {}
    for met, group in sets.items():
        cells = []
        for tp in EXIT_TPS:
            for sl in EXIT_SLS:
                trades = simulate_exits(group, candles, tp, sl)
                cells.append({"tp": tp, "sl": sl, "trades": trades,
                              **summarize_trades(trades)})
        grids[met] = cells

    forward = {}
    for met, group in sets.items():
        forward[met] = {}
        for regime in ("up", "down", "range"):
            regime_group = [d for d in group if d["regime"] == regime]
            forward[met][regime] = {
                h: summarize_net([forward_return(d, h, candles) for d in regime_group])
                for h in (4, 24)}

    baseline = {}
    for met, group in sets.items():
        trades = simulate_exits(group, candles, TAKE_PROFIT_PCT, STOP_LOSS_PCT)
        by_regime = {regime: summarize_trades(
            [t for t in trades if t["entry"]["regime"] == regime])
            for regime in ("up", "down", "range")}
        without_down = simulate_exits([d for d in group if d["regime"] != "down"], candles,
                                      TAKE_PROFIT_PCT, STOP_LOSS_PCT)
        baseline[met] = {"all": summarize_trades(trades), "byRegime": by_regime,
                         "withoutDown": summarize_trades(without_down)}
    return {"grids": grids, "forward": forward, "baseline": baseline}


def analyze(decisions, candles):
    close, high, low, ordered, ema, gap = candles
    for d in decisions:
        d["regime"] = regime_at(ema, ordered, d["cts"]) if d["cts"] else "unknown"
        d["gapShrink"] = gap_shrinking_at(gap, ordered, d["cts"]) if d["cts"] else False
        atr = d["cur"].get("atr")
        d["vol"] = "unknown" if not atr or not d["price"] else (
            "high" if atr / d["price"] * 100 >= 0.65 else "normal")

    def fwd(d, hours):
        return forward_return(d, hours, candles)

    def touch(d, hours=24):
        return virtual_touch(d, candles, hours)

    buckets = {}
    for met in (3, 2, 1, 0):
        group = [d for d in decisions if d["met"] == met]
        buckets[met] = {"n": len(group),
                        "h": {h: summarize([fwd(d, h) for d in group]) for h in HORIZONS},
                        "net": {h: summarize_net([fwd(d, h) for d in group]) for h in (4, 24)}}
    marginal = {}
    for missing in CORE:
        group = [d for d in decisions if d["met"] == 2 and not d["cond"].get(missing)]
        marginal[missing] = {"n": len(group),
                             "h": {h: summarize([fwd(d, h) for d in group]) for h in (4, 24)},
                             "net": {h: summarize_net([fwd(d, h) for d in group]) for h in (4, 24)}}
    near = [d for d in decisions if d["met"] == 2 and d["price"]]
    touches = Counter(touch(d) for d in near)
    variants = []
    for vid, label, pred in VARIANTS:
        fired = [d for d in decisions if pred(d)]
        variants.append({
            "id": vid, "label": label, "n": len(fired),
            "gross1": summarize([fwd(d, 1) for d in fired]),
            "net": {h: summarize_net([fwd(d, h) for d in fired]) for h in (4, 24)},
            "touches": Counter(touch(d) for d in fired if d["price"]),
        })
    flags = []
    for missing, m in marginal.items():
        s = m["net"][4]
        if s and s["n"] >= FLAG_MIN_SAMPLES and s["mean"] >= FLAG_MIN_MEAN_4H \
                and s["pos"] >= FLAG_MIN_POS_4H:
            flags.append({"kind": "candidate",
                          "text": f"{missing} の単独欠け（n={s['n']}）は正味 +4h 平均 {s['mean']:+.2f}%"
                                  f"（プラス率 {s['pos']:.0f}%）— 緩和候補として判断材料が揃った"})
    s2 = buckets[2]["net"][4]
    if s2 and s2["n"] >= FLAG_MIN_SAMPLES and s2["mean"] <= CAUTION_MAX_MEAN_4H:
        flags.append({"kind": "caution",
                      "text": f"あと1つで買えた判断（n={s2['n']}）は正味 +4h 平均 {s2['mean']:+.2f}%"
                              f" — 現行の厳しさが守っている側の証拠"})
    for v in variants:
        s = v["net"][4]
        if v["id"] != "base" and s and s["n"] >= FLAG_MIN_SAMPLES \
                and s["mean"] >= FLAG_MIN_MEAN_4H and s["pos"] >= FLAG_MIN_POS_4H:
            flags.append({"kind": "variant",
                          "text": f"バリアント「{v['label']}」（発火 n={s['n']}）は正味 +4h 平均 "
                                  f"{s['mean']:+.2f}%（プラス率 {s['pos']:.0f}%）— 採用候補として判断材料が揃った"})
    def grouped(key, order):
        out = {}
        for name in order:
            group = [d for d in decisions if d.get(key) == name]
            if not group:
                continue
            near_g = [d for d in group if d["met"] == 2]
            out[name] = {
                "n": len(group), "met": Counter(d["met"] for d in group),
                "near4": summarize([fwd(d, 4) for d in near_g]),
                "all4": summarize([fwd(d, 4) for d in group]),
            }
        return out

    regimes = grouped("regime", ("up", "down", "range", "unknown"))
    vols = grouped("vol", ("high", "normal", "unknown"))
    prices = [d["price"] for d in decisions if d["price"]]
    span = None
    if decisions:
        span = (datetime.fromtimestamp(decisions[0]["cts"], timezone.utc),
                datetime.fromtimestamp(decisions[-1]["cts"], timezone.utc))
    learning = analyze_learning(decisions, candles)
    return {"buckets": buckets, "marginal": marginal, "touches": touches,
            "flags": flags, "prices": prices, "span": span, "regimes": regimes,
            "variants": variants, "vols": vols,
            "learning": learning,
            "actions": Counter(d["action"] for d in decisions),
            "rules": Counter(d["rule"] for d in decisions)}


def load_shadow_decisions(db_path):
    """Read only public export fields. Older exports may omit the table."""
    conn = sqlite3.connect(db_path)
    try:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shadow_decisions'").fetchone():
            return []
        rows = conn.execute("SELECT id, json FROM shadow_decisions ORDER BY timestamp").fetchall()
    finally:
        conn.close()
    out = []
    for cycle_id, js in rows:
        row = json.loads(js)
        out.append({"cycleId": cycle_id, "cts": row.get("candleTimestamp"),
                    "price": row.get("price"), "status": row.get("status"),
                    "action": row.get("action"), "promptVersion": row.get("promptVersion")})
    return out


def score_shadow(group, candles):
    return {"n": len(group),
            "h": {h: summarize([forward_return(d, h, candles) for d in group]) for h in HORIZONS},
            "net": {h: summarize_net([forward_return(d, h, candles) for d in group]) for h in HORIZONS},
            "touches": Counter(virtual_touch(d, candles) for d in group if d["price"])}


def analyze_shadow(rows, decisions, candles):
    """Independent, version-separated evidence. Never mutates rule results.

    Four-way comparison uses the registered base predicate, not action or
    the copied ruleAction. Same-period base includes every rule decision
    inside this version's valid joined OK span (not only triggered cycles).
    """
    by_id = {d["cycleId"]: d for d in decisions if "cycleId" in d}
    result = {"n": len(rows), "statuses": Counter(r["status"] for r in rows), "versions": {}}
    for version in sorted({r["promptVersion"] for r in rows if r["promptVersion"]}):
        source = [r for r in rows if r["promptVersion"] == version]
        joined, invalid = [], 0
        for r in source:
            if r["status"] != "OK":
                continue
            rule = by_id.get(r["cycleId"])
            price = r["price"]
            if (rule is None or type(r["cts"]) is not int or r["cts"] != rule["cts"]
                    or r["action"] not in ("BUY", "WAIT")
                    or type(price) not in (int, float) or not math.isfinite(price) or price <= 0):
                invalid += 1
                continue
            atr = rule["cur"].get("atr")
            joined.append({**r, "ruleBuy": pred_base(rule),
                           "regime": regime_at(candles[4], candles[3], r["cts"]),
                           "vol": "unknown" if not atr else ("high" if atr / price * 100 >= 0.65 else "normal")})
        buys = [d for d in joined if d["action"] == "BUY"]
        groups = {group["key"]: [d for d in joined
                  if d["action"] == group["action"] and d["ruleBuy"] is group["ruleBuy"]]
                  for group in SHADOW_COMPARISON["groups"]}
        comparisons = {k: score_shadow(g, candles) for k, g in groups.items()}
        ai = comparisons["ai_only"]["net"][4]
        regimes = {d["regime"] for d in groups["ai_only"]
                   if d["regime"] != "unknown" and forward_return(d, 4, candles) is not None}
        span = (min(d["cts"] for d in joined), max(d["cts"] for d in joined)) if joined else None
        base = score_shadow([d for d in decisions if span and span[0] <= d["cts"] <= span[1] and pred_base(d)], candles)
        base4 = base["net"][4]
        checks = {
            "samples": bool(ai and ai["n"] >= FLAG_MIN_SAMPLES),
            "mean": bool(ai and ai["mean"] >= FLAG_MIN_MEAN_4H),
            "positive": bool(ai and ai["pos"] >= FLAG_MIN_POS_4H),
            "regimes": len(regimes) >= 2,
            "base": bool(ai and base4 and ai["mean"] >= base4["mean"]),
        }
        result["versions"][version] = {
            "statuses": Counter(r["status"] for r in source), "invalid": invalid,
            "buy": score_shadow(buys, candles), "comparisons": comparisons,
            "regimes": {k: score_shadow([d for d in buys if d["regime"] == k], candles)
                        for k in ("up", "down", "range", "unknown")},
            "vols": {k: score_shadow([d for d in buys if d["vol"] == k], candles)
                     for k in ("high", "normal", "unknown")},
            "base": base, "span": span, "regimeCount": len(regimes), "checks": checks,
        }
    return result


def fmt_shadow_stat(s):
    return "—（採点可能な標本なし）" if s is None else (
        f"平均 {s['mean']:+.2f}% / 中央値 {s['median']:+.2f}% / プラス率 {s['pos']:.0f}% / n={s['n']}")


def render_shadow(shadow):
    lines = ["", "## AI 影運用（記録専用・証拠のみ）", ""]
    if not shadow["n"]:
        return "\n".join(lines + ["記録なし（影運用は未有効化）", ""])
    counts = shadow["statuses"]
    lines += [f"記録 {shadow['n']} 件：OK {counts.get('OK', 0)} / ERROR {counts.get('ERROR', 0)} / "
              f"SKIPPED_BUDGET {counts.get('SKIPPED_BUDGET', 0)} / SKIPPED_DISABLED {counts.get('SKIPPED_DISABLED', 0)}。"
              "ERROR／SKIPPED は件数のみで採点に含めない。",
              "", "影 BUY はスリッページ・不約定・ProfitGuard 棄却という約定の現実を通らない近似で、"
              "既存のニアミス採点と同じ限界がある。正味は往復0.6%の手数料のみ控除し、実弾ではさらに不利側。",
              "+24h 等の未経過・足欠損はリターンの標本から除外。仮想タッチは既存採点と同様、取得済み24h以内の足で判定する。",
              "cycleId で結合し、ルールBUYは事前登録 base 候補として判定。コピーされた ruleAction は使わない。"]
    for version, group in shadow["versions"].items():
        lines += ["", f"### promptVersion: {version}", "",
                  f"状態別件数: {dict(group['statuses'])}。OK の結合不可／入力不整合 {group['invalid']} 件は採点除外。",
                  "", f"影 BUY 候補: {group['buy']['n']} 件（版を混ぜず集計）", "",
                  "| 期間 | 素 | 正味（往復0.6%控除） |", "|---|---|---|"]
        for h in HORIZONS:
            lines.append(f"| +{h}h | {fmt_shadow_stat(group['buy']['h'][h])} | {fmt_shadow_stat(group['buy']['net'][h])} |")
        t = group["buy"]["touches"]
        lines += ["", "仮想タッチ（24h以内、利確 +1.5%／損切り −1.0%）: "
                  f"利確先行 {t.get('tp_first', 0)} / 損切り先行 {t.get('sl_first', 0)} / "
                  f"同足 {t.get('both_same_bar', 0)} / どちらもなし {t.get('neither', 0)}", "",
                  "| 一致／不一致 | 件数 | 正味 +4h |", "|---|---|---|"]
        for key, label in (("ai_only", "AI のみ BUY"), ("rule_only", "ルールのみ BUY"),
                           ("both_buy", "両者 BUY"), ("both_wait", "両者 WAIT")):
            g = group["comparisons"][key]
            lines.append(f"| {label} | {g['n']} | {fmt_shadow_stat(g['net'][4])} |")
        for name, labels in (("regimes", {"up": "上昇", "down": "下降", "range": "横ばい", "unknown": "不明"}),
                             ("vols", {"high": "高ボラ", "normal": "通常ボラ", "unknown": "不明"})):
            lines += ["", "局面別（EMA50の24h傾き ±0.5%）" if name == "regimes" else "ボラ帯別（ATR% ≥0.65が高ボラ、同サイクルのルール指標を参照）", "",
                      "| 帯 | 影BUY件数 | 素 +4h | 正味 +4h |", "|---|---|---|---|"]
            for key, label in labels.items():
                g = group[name][key]
                lines.append(f"| {label} | {g['n']} | {fmt_shadow_stat(g['h'][4])} | {fmt_shadow_stat(g['net'][4])} |")
        ai = group["comparisons"]["ai_only"]["net"][4]
        lines += ["", "卒業条件チェックリスト（事前登録・仮置き、表示のみ）", "",
                  "AIのみBUYのうち正味+4hが採点可能な標本で判定。不明局面は局面数に数えない。",
                  f"同期間 base: {group['span']}（candleTimestamp、epoch秒）、正味 +4h {fmt_shadow_stat(group['base']['net'][4])}"]
        labels = {
            "samples": f"AI のみ BUY: n ≥ {FLAG_MIN_SAMPLES}（採点可能 n={ai['n'] if ai else 0}）",
            "mean": f"正味 +4h 平均 ≥ +{FLAG_MIN_MEAN_4H:.2f}%（{fmt_shadow_stat(ai)}）",
            "positive": f"正味 +4h プラス率 ≥ {FLAG_MIN_POS_4H:.0f}%",
            "regimes": f"2局面以上に分散（{group['regimeCount']}局面）",
            "base": "同期間ルール base の正味 +4h 平均以上（比較不能は未充足）",
        }
        for key, label in labels.items():
            lines.append(f"- [{'x' if group['checks'][key] else ' '}] {label}")
        lines += ["", "全条件充足" if all(group["checks"].values()) else "未充足",
                  "卒業は判断材料の表示のみ。注文・設定・パラメータ・安全系・権限は何も自動で変えない。"]
    return "\n".join(lines + [""])


def fmt_stat(s):
    return "—" if s is None else f"{s['mean']:+.2f}%（プラス {s['pos']:.0f}%、n={s['n']}）"


def fmt_forecast_bias(tally):
    if tally["n"] < FORECAST_MIN_SAMPLES:
        return None
    n = tally["n"]
    return (f"収まり率 {tally['inside'] / n * 100:.0f}%・"
            f"上振れ率 {tally['above'] / n * 100:.0f}%・"
            f"下振れ率 {tally['below'] / n * 100:.0f}%（n={n}）")


def horizon_text(seconds):
    return f"{seconds // 3600}h" if seconds % 3600 == 0 else f"{seconds // 60}分"


def render(result, decisions_count, orders, trades, generated_at, shadow=None,
           forecast_bias=None):
    b, m = result["buckets"], result["marginal"]
    prices = result["prices"]
    lines = ["# SuiBa 振り返りレポート（段階1）", ""]
    if result["span"]:
        lines.append(f"- 対象期間: {result['span'][0]:%Y-%m-%d %H:%M} 〜 "
                     f"{result['span'][1]:%Y-%m-%d %H:%M} UTC")
    lines.append(f"- 生成: {generated_at:%Y-%m-%d %H:%M} UTC（自動生成・証拠専用、売買ルールは変更しない）")
    lines.append(f"- 判断: {decisions_count} 件（{dict(result['actions'])}）、"
                 f"注文 {orders} 件・約定 {trades} 件")
    lines.append(f"- 判断理由: {dict(result['rules'])}")
    if prices:
        lines.append(f"- 価格: {prices[0]:.4f} → {prices[-1]:.4f}"
                     f"（{(prices[-1] / prices[0] - 1) * 100:+.2f}%、安値 {min(prices):.4f}・高値 {max(prices):.4f}）")
    lines += ["", "## 条件充足数別「買っていたら」（その後の価格変化）", "",
              "| 充足数 | 件数 | +1h 平均 | +4h 平均 | +24h 平均 |", "|---|---|---|---|---|"]
    for met, label in ((3, "3（買い信号）"), (2, "2（あと1つ）"), (1, "1"), (0, "0")):
        bk = b[met]
        lines.append(f"| {label} | {bk['n']} | {fmt_stat(bk['h'][1])} | "
                     f"{fmt_stat(bk['h'][4])} | {fmt_stat(bk['h'][24])} |")
    t = result["touches"]
    lines += ["", f"あと1つの判断への仮想タッチ（24h 以内、利確 +1.5%／損切り −1.0%）: "
                  f"利確先行 {t.get('tp_first', 0)} 件 / 損切り先行 {t.get('sl_first', 0)} 件 / "
                  f"同足 {t.get('both_same_bar', 0)} 件 / どちらもなし {t.get('neither', 0)} 件",
              "", "## 条件ごとの値打ち（あと1つで買えた判断の内訳）", ""]
    for missing in CORE:
        mm = m[missing]
        lines.append(f"- {missing} だけ欠け: {mm['n']} 件、+4h {fmt_stat(mm['h'][4])}、+24h {fmt_stat(mm['h'][24])}")
    lines += ["", f"## コスト控除後（往復 {ROUND_TRIP_COST_PCT:.1f}%＝手数料 0.3%/回、スリッページ未控除）", "",
              f"- あと1つ全体: 正味 +4h {fmt_stat(b[2]['net'][4])}、正味 +24h {fmt_stat(b[2]['net'][24])}"]
    for missing in CORE:
        mm = m[missing]
        lines.append(f"- {missing} だけ欠け: 正味 +4h {fmt_stat(mm['net'][4])}、正味 +24h {fmt_stat(mm['net'][24])}")
    lines += ["", "## 候補バリアントの採点（発火した判断のその後）", "",
              "| バリアント | 発火 | +1h 平均（素） | +4h 平均（正味） | +24h 平均（正味） | 利確先行/損切り先行 |",
              "|---|---|---|---|---|---|"]
    for v in result["variants"]:
        t = v["touches"]
        lines.append(f"| {v['label']} | {v['n']} | {fmt_stat(v['gross1'])} | "
                     f"{fmt_stat(v['net'][4])} | {fmt_stat(v['net'][24])} | "
                     f"{t.get('tp_first', 0)}/{t.get('sl_first', 0)} |")
    if shadow:
        for version, group in shadow["versions"].items():
            v = group["buy"]
            t = v["touches"]
            lines.append(f"| 影BUY（{version}） | {v['n']} | {fmt_stat(v['h'][1])} | "
                         f"{fmt_stat(v['net'][4])} | {fmt_stat(v['net'][24])} | "
                         f"{t.get('tp_first', 0)}/{t.get('sl_first', 0)} |")
    lines += render_learning(result["learning"])
    lines += ["", "## 局面別の内訳（EMA50 の24h傾き：上昇 ≥+0.5%／下降 ≤−0.5%／横ばい）", ""]
    labels = {"up": "上昇", "down": "下降", "range": "横ばい", "unknown": "不明"}
    for name, r in result["regimes"].items():
        lines.append(f"- {labels[name]}: {r['n']} 件（充足数内訳 {dict(sorted(r['met'].items()))}）、"
                     f"あと1つの +4h {fmt_stat(r['near4'])}、全体の +4h {fmt_stat(r['all4'])}")
    lines += ["", "## ボラティリティ別の内訳（ATR%：高ボラ ≥0.65＝天気の“嵐”境界）", ""]
    vlabels = {"high": "高ボラ", "normal": "通常ボラ", "unknown": "不明"}
    for name, r in result["vols"].items():
        lines.append(f"- {vlabels[name]}: {r['n']} 件（充足数内訳 {dict(sorted(r['met'].items()))}）、"
                     f"あと1つの +4h {fmt_stat(r['near4'])}、全体の +4h {fmt_stat(r['all4'])}")
    if forecast_bias and forecast_bias["n"]:
        lines += ["", "## 予測コーンの方向バイアス（成熟済み）", ""]
        regime_labels = {"up": "上昇", "down": "下降", "range": "横ばい", "unknown": "不明"}
        for horizon, tally in forecast_bias["horizons"].items():
            summary = fmt_forecast_bias(tally)
            if summary is None:
                continue
            lines.append(f"- {horizon_text(horizon)}: {summary}")
            details = [(regime_labels[name], fmt_forecast_bias(regime))
                       for name, regime in tally["regimes"].items()]
            details = [(label, text) for label, text in details if text is not None]
            if details:
                lines += ["", "<details>", f"<summary>{horizon_text(horizon)} の局面別内訳</summary>", ""]
                lines += [f"- {label}: {text}" for label, text in details]
                lines += ["", "</details>"]
    lines += ["", "## フラグ", ""]
    if result["flags"]:
        for f in result["flags"]:
            lines.append(f"- [{f['kind']}] {f['text']}")
    else:
        lines.append("- なし（候補・注意どちらも閾値未達）")
    lines += ["", "## 注意", "",
              "- 「素」の値は手数料・スリッページ・ProfitGuard 未考慮の値動き。正味の欄は手数料"
              "（設定既定 0.3%/回、export に実設定が含まれないため既定値で代用）を控除し、"
              "スリッページは未控除なので実際はさらに不利側。フラグ判定は正味ベース。",
              "- +24h は直近の判断ぶんが未経過のため標本が減る。",
              "- 標本が1つの相場つきに偏る間は、フラグは「判断材料が揃った」合図にすぎない。",
              ""]
    text = "\n".join(lines)
    return text if shadow is None else text + render_shadow(shadow)


def parse_time(text):
    """Epoch seconds, or an ISO date/datetime read as UTC."""
    if text.isdigit():
        return int(text)
    return int(datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp())


def main(argv):
    db = argv[1]
    candles_path = None
    out = None
    since = until = None
    window = None
    i = 2
    while i < len(argv):
        if argv[i] == "--candles":
            candles_path = argv[i + 1]
            i += 2
        elif argv[i] == "--out":
            out = argv[i + 1]
            i += 2
        elif argv[i] == "--since":
            since = parse_time(argv[i + 1])
            i += 2
        elif argv[i] == "--until":
            until = parse_time(argv[i + 1])
            i += 2
        elif argv[i] == "--window":
            window = argv[i + 1]
            i += 2
        else:
            i += 1
    decisions, orders, trades = load_decisions(db)
    forecasts = load_forecasts(db)
    undetermined = False
    if window == "last-session":
        session = load_last_session_window(db)
        if session is None:
            undetermined = True
        else:
            since, until = session
    if since is not None or until is not None:
        decisions = filter_window(decisions, since, until)
        forecasts = [f for f in forecasts
                     if (since is None or f["origin"] >= since)
                     and (until is None or f["origin"] <= until)]
    if undetermined or (window == "last-session" and not decisions):
        if out:
            with open(out, "w") as fh:
                fh.write(UNDETERMINED_WINDOW)
        print(UNDETERMINED_WINDOW)
        return 0
    if candles_path:
        raw = json.load(open(candles_path))["candles"]
    else:
        candle_sources = sorted(
            decisions + [{"cts": f["origin"]} for f in forecasts],
            key=lambda row: row["cts"])
        raw = fetch_candles(candle_sources)
    candles = load_candles(raw)
    result = analyze(decisions, candles)
    shadow_rows = filter_window(load_shadow_decisions(db), since, until)
    shadow = analyze_shadow(shadow_rows, decisions, candles)
    forecast_bias = analyze_forecast_bias(forecasts, candles)
    text = render(result, len(decisions), orders, trades, datetime.now(timezone.utc),
                  shadow, forecast_bias)
    if out:
        with open(out, "w") as fh:
            fh.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
