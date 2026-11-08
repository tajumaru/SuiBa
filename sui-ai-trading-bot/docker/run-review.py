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
Without --candles, candles are fetched from the public Indexer.
"""
import json
import sqlite3
import statistics
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timezone

INDEXER = "https://deepbook-indexer.mainnet.mystenlabs.com/ohclv/SUI_USDC"
CORE = ["emaUp", "rsiRecovery", "histogramImproving"]
HORIZONS = (1, 4, 24)
# Candidate-flag thresholds (v1 heuristics, see docs/RUN_REVIEW_JA.md):
FLAG_MIN_SAMPLES = 30
FLAG_MIN_MEAN_4H = 0.30   # percent
FLAG_MIN_POS_4H = 50.0    # percent
CAUTION_MAX_MEAN_4H = -0.30


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
    return close, high, low, sorted(close)


def load_decisions(db_path):
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT json FROM strategy_decisions ORDER BY timestamp").fetchall()
        orders = conn.execute("SELECT COUNT(*) FROM paper_orders").fetchone()[0]
        trades = conn.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0]
    finally:
        conn.close()
    decisions = []
    for (js,) in rows:
        d = json.loads(js)
        ev = d.get("evidence") or {}
        cond = ev.get("conditions") or {}
        inp = ev.get("inputs") or {}
        decisions.append({
            "action": d.get("action"), "rule": ev.get("selectedRule"),
            "cts": ev.get("candleTimestamp"), "price": inp.get("price"),
            "cond": cond, "met": sum(1 for k in CORE if cond.get(k)),
        })
    return decisions, orders, trades


def summarize(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {"n": len(values), "mean": statistics.mean(values),
            "median": statistics.median(values),
            "pos": sum(1 for v in values if v > 0) / len(values) * 100}


def analyze(decisions, candles):
    close, high, low, ordered = candles

    def fwd(d, hours):
        if d["cts"] is None or not d["price"]:
            return None
        p = close.get(d["cts"] + hours * 3600)
        return None if p is None else (p / d["price"] - 1) * 100

    def touch(d, hours=24):
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

    buckets = {}
    for met in (3, 2, 1, 0):
        group = [d for d in decisions if d["met"] == met]
        buckets[met] = {"n": len(group),
                        "h": {h: summarize([fwd(d, h) for d in group]) for h in HORIZONS}}
    marginal = {}
    for missing in CORE:
        group = [d for d in decisions if d["met"] == 2 and not d["cond"].get(missing)]
        marginal[missing] = {"n": len(group),
                             "h": {h: summarize([fwd(d, h) for d in group]) for h in (4, 24)}}
    near = [d for d in decisions if d["met"] == 2 and d["price"]]
    touches = Counter(touch(d) for d in near)
    flags = []
    for missing, m in marginal.items():
        s = m["h"][4]
        if s and s["n"] >= FLAG_MIN_SAMPLES and s["mean"] >= FLAG_MIN_MEAN_4H \
                and s["pos"] >= FLAG_MIN_POS_4H:
            flags.append({"kind": "candidate",
                          "text": f"{missing} の単独欠け（n={s['n']}）は +4h 平均 {s['mean']:+.2f}%"
                                  f"（プラス率 {s['pos']:.0f}%）— 緩和候補として判断材料が揃った"})
    s2 = buckets[2]["h"][4]
    if s2 and s2["n"] >= FLAG_MIN_SAMPLES and s2["mean"] <= CAUTION_MAX_MEAN_4H:
        flags.append({"kind": "caution",
                      "text": f"あと1つで買えた判断（n={s2['n']}）は +4h 平均 {s2['mean']:+.2f}%"
                              f" — 現行の厳しさが守っている側の証拠"})
    prices = [d["price"] for d in decisions if d["price"]]
    span = None
    if decisions:
        span = (datetime.fromtimestamp(decisions[0]["cts"], timezone.utc),
                datetime.fromtimestamp(decisions[-1]["cts"], timezone.utc))
    return {"buckets": buckets, "marginal": marginal, "touches": touches,
            "flags": flags, "prices": prices, "span": span,
            "actions": Counter(d["action"] for d in decisions),
            "rules": Counter(d["rule"] for d in decisions)}


def fmt_stat(s):
    return "—" if s is None else f"{s['mean']:+.2f}%（プラス {s['pos']:.0f}%、n={s['n']}）"


def render(result, decisions_count, orders, trades, generated_at):
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
    lines += ["", "## フラグ", ""]
    if result["flags"]:
        for f in result["flags"]:
            lines.append(f"- [{f['kind']}] {f['text']}")
    else:
        lines.append("- なし（候補・注意どちらも閾値未達）")
    lines += ["", "## 注意", "",
              "- その後の価格変化は手数料・スリッページ・ProfitGuard 未考慮の素の値動き。",
              "- +24h は直近の判断ぶんが未経過のため標本が減る。",
              "- 標本が1つの相場つきに偏る間は、フラグは「判断材料が揃った」合図にすぎない。",
              ""]
    return "\n".join(lines)


def main(argv):
    db = argv[1]
    candles_path = None
    out = None
    i = 2
    while i < len(argv):
        if argv[i] == "--candles":
            candles_path = argv[i + 1]
            i += 2
        elif argv[i] == "--out":
            out = argv[i + 1]
            i += 2
        else:
            i += 1
    decisions, orders, trades = load_decisions(db)
    if candles_path:
        raw = json.load(open(candles_path))["candles"]
    else:
        raw = fetch_candles(decisions)
    result = analyze(decisions, load_candles(raw))
    text = render(result, len(decisions), orders, trades, datetime.now(timezone.utc))
    if out:
        with open(out, "w") as fh:
            fh.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
