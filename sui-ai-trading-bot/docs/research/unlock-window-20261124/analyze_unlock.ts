/**
 * Unlock-window study (analysis only, no app changes).
 * Reproduces POTARIO buy signals with the production RuleBasedStrategy
 * (imported from the current-main checkout in SuiBa-shapeguard) over
 * SUI_USDC 5m candles, then splits signals by SUI token-unlock windows:
 *   anchor = 1st of month 00:00 UTC
 *   pre  = [anchor-72h, anchor)
 *   post = [anchor, anchor+168h)
 *   outside = everything else (overlap of two windows would be excluded)
 * Forward returns from the signal candle close at +1h/+4h/+24h;
 * net = gross - 0.6% round-trip yardstick.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { RuleBasedStrategy } from "/home/hatch/workspace/apps/SuiBa-shapeguard/sui-ai-trading-bot/packages/strategy-engine/src/index.ts";
import { calculateSeries } from "/home/hatch/workspace/apps/SuiBa-shapeguard/sui-ai-trading-bot/packages/indicators/src/index.ts";
import { defaults } from "/home/hatch/workspace/apps/SuiBa-shapeguard/sui-ai-trading-bot/packages/shared/src/index.ts";
import type {
  Candle,
  Settings,
} from "/home/hatch/workspace/apps/SuiBa-shapeguard/sui-ai-trading-bot/packages/shared/src/index.ts";

const STUDY_DIR = "/home/hatch/workspace/analysis-cache/unlock-study-20261124";
const STEP_MS = 300_000;
const COST = 0.006; // round-trip yardstick 0.6%

// Production settings: schema defaults + oversold 45 + EMA gap shrink on (3).
const settings: Settings = {
  ...defaults,
  oversold: 45,
  emaGapShrinkEnabled: true,
  emaGapShrinkCandles: 3,
};

type Row = [number, number, number, number, number, number];
const raw = JSON.parse(readFileSync(`${STUDY_DIR}/candles.json`, "utf8")) as {
  candles: Row[];
};
const rows = raw.candles;
const byTs = new Map<number, Row>(rows.map((r) => [r[0], r]));
const firstTs = rows[0]![0];
const lastTs = rows.at(-1)![0];

// Fill missing 5m slots with flat candles (previous close, volume 0),
// the same treatment the earlier backtest work used for gap slots.
const candles: Candle[] = [];
let gapSlots = 0;
let prevClose = rows[0]![4];
for (let t = firstTs; t <= lastTs; t += STEP_MS) {
  const r = byTs.get(t);
  if (r) {
    prevClose = r[4];
    candles.push({
      timestamp: t / 1000,
      open: r[1],
      high: r[2],
      low: r[3],
      close: r[4],
      volume: r[5],
      source: "DeepBook:SUI_USDC:USDC",
      timeframe: 300,
    });
  } else {
    gapSlots++;
    candles.push({
      timestamp: t / 1000,
      open: prevClose,
      high: prevClose,
      low: prevClose,
      close: prevClose,
      volume: 0,
      source: "DeepBook:SUI_USDC:USDC",
      timeframe: 300,
    });
  }
}
console.log(
  `candles=${candles.length} gapsFilled=${gapSlots} range=${new Date(firstTs).toISOString()}..${new Date(lastTs).toISOString()}`,
);

const series = calculateSeries(candles);
const strategy = new RuleBasedStrategy(settings);
const buyIdx: number[] = [];
const prefix: Candle[] = [];
const t0 = Date.now();
for (let i = 0; i < candles.length; i++) {
  prefix.push(candles[i]!);
  const cur = series[i];
  const prev = i > 0 ? series[i - 1] : null;
  if (!cur || !prev) continue;
  const d = await strategy.analyze({
    candles: prefix,
    current: cur,
    previous: prev,
    entryPrice: null,
    now: (candles[i]!.timestamp + 300) * 1000,
  });
  if (d.action === "BUY") buyIdx.push(i);
  if (i % 10000 === 0)
    console.log(`  i=${i} buys=${buyIdx.length} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log(`analyze done: buys=${buyIdx.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// Episodes: consecutive BUY candles are one episode, measured at the first.
const episodeIdx: number[] = [];
{
  let prevBuy: number | null = null;
  for (const i of buyIdx) {
    if (prevBuy === null || i !== prevBuy + 1) episodeIdx.push(i);
    prevBuy = i;
  }
}

// Unlock anchors: 1st of each month 00:00 UTC, 2026-05-01 .. 2026-11-01.
const H = 3600_000;
const anchors: number[] = [];
for (let m = 4; m <= 10; m++) anchors.push(Date.UTC(2026, m, 1));
type Cat = "pre" | "post" | "outside" | "overlap-excluded";
const classify = (tMs: number): Cat => {
  const inPre = anchors.some((a) => tMs >= a - 72 * H && tMs < a);
  const inPost = anchors.some((a) => tMs >= a && tMs < a + 168 * H);
  if (inPre && inPost) return "overlap-excluded";
  if (inPre) return "pre";
  if (inPost) return "post";
  return "outside";
};

const HORIZONS = { h1: 12, h4: 48, h24: 288 } as const;
type Horizon = keyof typeof HORIZONS;
interface SigRec {
  index: number;
  timeMs: number;
  cat: Cat;
  gross: Record<Horizon, number | null>;
}
const toRec = (i: number): SigRec => {
  const gross = {} as Record<Horizon, number | null>;
  for (const [k, steps] of Object.entries(HORIZONS) as [Horizon, number][]) {
    gross[k] =
      i + steps < candles.length
        ? candles[i + steps]!.close / candles[i]!.close - 1
        : null;
  }
  return { index: i, timeMs: candles[i]!.timestamp * 1000, cat: classify(candles[i]!.timestamp * 1000), gross };
};
const episodeRecs = episodeIdx.map(toRec);
const allRecs = buyIdx.map(toRec);

interface Agg {
  n: Record<Horizon, number>;
  meanGrossPct: Record<Horizon, number | null>;
  meanNetPct: Record<Horizon, number | null>;
}
const agg = (recs: SigRec[]): Agg => {
  const n = { h1: 0, h4: 0, h24: 0 } as Record<Horizon, number>;
  const sum = { h1: 0, h4: 0, h24: 0 } as Record<Horizon, number>;
  for (const r of recs)
    for (const k of Object.keys(HORIZONS) as Horizon[])
      if (r.gross[k] !== null) {
        n[k]++;
        sum[k] += r.gross[k]!;
      }
  const meanGrossPct = {} as Record<Horizon, number | null>;
  const meanNetPct = {} as Record<Horizon, number | null>;
  for (const k of Object.keys(HORIZONS) as Horizon[]) {
    meanGrossPct[k] = n[k] ? (sum[k] / n[k]) * 100 : null;
    meanNetPct[k] = n[k] ? (sum[k] / n[k] - COST) * 100 : null;
  }
  return { n, meanGrossPct, meanNetPct };
};
const cats: Cat[] = ["pre", "post", "outside", "overlap-excluded"];
const summarize = (recs: SigRec[]) => {
  const out: Record<string, Agg & { episodesOrSignals: number }> = {} as never;
  for (const c of cats) {
    const sub = recs.filter((r) => r.cat === c);
    out[c] = { episodesOrSignals: sub.length, ...agg(sub) };
  }
  out.all = { episodesOrSignals: recs.length, ...agg(recs) };
  return out;
};
const epSummary = summarize(episodeRecs);
const allSummary = summarize(allRecs);

// Diffs (category net mean minus outside net mean), percentage points.
const diffs = (s: typeof epSummary) => {
  const out: Record<string, Record<Horizon, number | null>> = {};
  for (const c of ["pre", "post"] as const) {
    out[c] = {} as Record<Horizon, number | null>;
    for (const k of Object.keys(HORIZONS) as Horizon[]) {
      const a = s[c]!.meanNetPct[k];
      const b = s.outside!.meanNetPct[k];
      out[c]![k] = a !== null && b !== null ? a - b : null;
    }
  }
  return out;
};

const results = {
  meta: {
    pair: "SUI_USDC",
    interval: "5m",
    candleRange: {
      from: new Date(firstTs).toISOString(),
      to: new Date(lastTs).toISOString(),
      rawRows: rows.length,
      filledCandles: candles.length,
      gapSlotsFilled: gapSlots,
    },
    anchorsUtc: anchors.map((a) => new Date(a).toISOString()),
    windows: { pre: "[-72h, 0h)", post: "[0h, +168h)" },
    settings: {
      oversold: settings.oversold,
      emaGapShrinkEnabled: settings.emaGapShrinkEnabled,
      emaGapShrinkCandles: settings.emaGapShrinkCandles,
      maxVolumeChange: settings.maxVolumeChange,
      note: "schema defaults otherwise; entryPrice null; no ProfitGuard entry replication",
    },
    costYardstickPct: 0.6,
    totalBuySignals: buyIdx.length,
    totalEpisodes: episodeIdx.length,
  },
  episodes: epSummary,
  episodeDiffsVsOutside: diffs(epSummary),
  allSignals: allSummary,
  allSignalDiffsVsOutside: diffs(allSummary),
  episodeDetail: episodeRecs.map((r) => ({
    timeUtc: new Date(r.timeMs).toISOString(),
    cat: r.cat,
    grossPct: Object.fromEntries(
      Object.entries(r.gross).map(([k, v]) => [k, v === null ? null : v * 100]),
    ),
  })),
};
writeFileSync(`${STUDY_DIR}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ episodes: epSummary, episodeDiffsVsOutside: results.episodeDiffsVsOutside }, null, 2));
