// Offline replay only. Uses checked-in public observations; no network or real orders.
import { readFileSync, writeFileSync } from "node:fs";
import { parseDeepBook } from "../packages/market-data/src/deepbook.ts";
import {
  reconstructFiveMinutes,
  type EmptyTradeProof,
} from "../packages/market-data/src/reconstruction.ts";
import { validateCandles } from "../packages/market-data/src/validation.ts";
import { calculate } from "../packages/indicators/src/index.ts";
import { RuleBasedStrategy } from "../packages/strategy-engine/src/index.ts";
import {
  compareBacktests,
  modelQuote,
} from "../packages/backtest-engine/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  defaults,
  type Candle,
  type Timeframe,
} from "../packages/shared/src/index.ts";
const dir = "docs/evidence/gaps/",
  h = JSON.parse(readFileSync(dir + "historical-5m.json", "utf8")),
  x = JSON.parse(readFileSync(dir + "cross-check.json", "utf8"));
const raw = parseDeepBook(h.raw, 300, h.to * 1000) as Candle[],
  minutes = parseDeepBook({ candles: x.minutes }, 60, h.to * 1000);
const proofs = new Map<number, EmptyTradeProof>(
  x.gaps.map((g: any) => {
    const path =
      "/trades/SUI_USDC?start_time=" +
      g.timestamp +
      "&end_time=" +
      (g.timestamp + 300) +
      "&limit=1000";
    return [
      g.timestamp,
      {
        source: "DeepBook Indexer",
        pair: "SUI_USDC",
        start: g.timestamp,
        end: g.timestamp + 300,
        fetchedAt: x.queries.find((q: any) => q.path === path).observedAt,
        indexedThrough: x.finalStatus.pipelines.find(
          (p: any) => p.pipeline === "order_fill" && !p.is_backfill,
        ).indexed_timestamp_ms,
        complete: g.queryComplete,
        tradeCount: g.trades.length,
        path,
      },
    ];
  }),
);
const rebuilt = reconstructFiveMinutes(raw, minutes, proofs, x.completedAt),
  after = rebuilt.candles;
validateCandles(after, 300, h.to * 1000);
const options = {
  start: after[65].timestamp,
  end: after.at(-1)!.timestamp,
  trainEnd: after[64].timestamp,
};
let beforeBacktest: unknown;
try {
  await compareBacktests(raw, options);
  beforeBacktest = { unexpected: "accepted" };
} catch (e) {
  beforeBacktest = { blocked: (e as Error).message };
}
const comparison = await compareBacktests(after, options);
const strategy = new RuleBasedStrategy(defaults),
  beforeCounts = { BUY: 0, SELL: 0, WAIT: 0 },
  afterCounts = { BUY: 0, SELL: 0, WAIT: 0 };
const maxDiagnosticDelta: Record<
  string,
  { absolute: number; timestamp: number }
> = {};
for (let i = 61; i < after.length; i++) {
  const rows = after.slice(0, i + 1),
    original = raw.filter((c) => c.timestamp <= rows.at(-1)!.timestamp);
  let action: "BUY" | "SELL" | "WAIT" = "WAIT";
  try {
    validateCandles(original, 300, (rows.at(-1)!.timestamp + 300) * 1000);
    action = (
      await strategy.analyze({
        candles: original,
        current: calculate(original),
        previous: calculate(original.slice(0, -1)),
        entryPrice: null,
        now: (rows.at(-1)!.timestamp + 300) * 1000,
      })
    ).action;
  } catch {}
  beforeCounts[action]++;
  if (original.length >= 61) {
    const a = calculate(original),
      b = calculate(rows);
    for (const [k, v] of Object.entries(b)) {
      const d = Math.abs(v - (a as any)[k]);
      if (!maxDiagnosticDelta[k] || d > maxDiagnosticDelta[k].absolute)
        maxDiagnosticDelta[k] = {
          absolute: d,
          timestamp: rows.at(-1)!.timestamp,
        };
    }
  }
  const next = await strategy.analyze({
    candles: rows,
    current: calculate(rows),
    previous: calculate(rows.slice(0, -1)),
    entryPrice: null,
    now: (rows.at(-1)!.timestamp + 300) * 1000,
  });
  afterCounts[next.action]++;
}
function aggregate(rows: Candle[], tf: Timeframe): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const c of rows) {
    const t = Math.floor(c.timestamp / tf) * tf;
    groups.set(t, [...(groups.get(t) ?? []), c]);
  }
  return [...groups]
    .filter(([, r]) => r.length === tf / 300)
    .map(([timestamp, r]) => ({
      timestamp,
      timeframe: tf,
      source: r[0].source,
      open: r[0].open,
      high: Math.max(...r.map((c) => c.high)),
      low: Math.min(...r.map((c) => c.low)),
      close: r.at(-1)!.close,
      volume: r.reduce((n, c) => n + c.volume, 0),
    }));
}
const fifteen = parseDeepBook({ candles: x.fifteen }, 900, h.to * 1000),
  agg = aggregate(after, 900);
let matches = 0,
  mismatches = 0;
let unfilledMatches = 0,
  unfilledMismatches = 0;
for (const c of agg) {
  const r = fifteen.find((x) => x.timestamp === c.timestamp);
  if (!r) {
    mismatches++;
    continue;
  }
  if (
    ["open", "high", "low", "close", "volume"].every(
      (k) =>
        Math.abs((c as any)[k] - (r as any)[k]) <=
        Math.max(1e-8, Math.abs((r as any)[k]) * 1e-10),
    )
  )
    matches++;
  else mismatches++;
}
for (const c of agg) {
  const r = fifteen.find((x) => x.timestamp === c.timestamp)!;
  const original = after.filter(
    (x) =>
      x.timestamp >= c.timestamp &&
      x.timestamp < c.timestamp + 900 &&
      x.provenance?.origin !== "NO_INDEXED_TRADES",
  );
  if (!original.length) continue;
  const values = [
    original[0].open,
    Math.max(...original.map((x) => x.high)),
    Math.min(...original.map((x) => x.low)),
    original.at(-1)!.close,
    original.reduce((n, x) => n + x.volume, 0),
  ];
  if (
    r &&
    values.every(
      (v, i) =>
        Math.abs(v - [r.open, r.high, r.low, r.close, r.volume][i]) <=
        Math.max(1e-8, Math.abs(v) * 1e-10),
    )
  )
    unfilledMatches++;
  else unfilledMismatches++;
}
const fixedNow = h.to * 1000,
  actualNow = Date.now;
let paper: unknown;
try {
  Date.now = () => fixedNow;
  const db = new BotDatabase(":memory:");
  db.set("runtime", { ...db.runtime(), running: true });
  const engine = new BotEngine(
    db,
    { candles: async (tf) => (tf === 300 ? after : aggregate(after, tf)) },
    {
      getQuote: async (r) =>
        modelQuote(r, fixedNow, after.at(-2)!.volume, {
          spread: 0.001,
          impact: 0.001,
          dexFeeRate: 0.003,
          participation: 0.001,
        }),
      validateQuote: async (q) => q.expiresAt > Date.now(),
    },
    {
      health: async () => ({ healthy: true, checkedAt: fixedNow, failures: 0 }),
      status: { healthy: true, checkedAt: fixedNow, failures: 0 },
    },
  );
  await engine.tick();
  paper = {
    kind: "single-cycle in-memory PAPER replay; synthetic quotes",
    runtime: db.runtime(),
    decision: db.get("decision"),
    trades: db.history("paper_trades").length,
  };
  db.close();
} finally {
  Date.now = actualNow;
}
const beforeIndicators = calculate(raw),
  afterIndicators = calculate(after);
const result = {
  quality: rebuilt.quality,
  classification: x.gaps.map((g: any) => ({
    timestamp: g.timestamp,
    utc: g.utc,
    classification:
      g.queryComplete && !g.trades.length && g.minuteCount === 0
        ? "NO_INDEXED_TRADES"
        : "UNRESOLVED",
    trades: g.trades.length,
    minuteCount: g.minuteCount,
    scope: "official Indexer; no exhaustive independent chain absence proof",
  })),
  beforeIndicators: {
    diagnosticOnly: true,
    validTradingInput: false,
    values: beforeIndicators,
  },
  afterIndicators,
  difference: Object.fromEntries(
    Object.entries(afterIndicators).map(([k, v]) => [
      k,
      v - (beforeIndicators as any)[k],
    ]),
  ),
  decisions: {
    scope:
      "same UTC decision points, flat position, unchanged default rule-based strategy; invalid original prefix WAIT",
    before: beforeCounts,
    after: afterCounts,
  },
  fifteenConsistency: {
    filledConvention: { matches, mismatches },
    originalTradeOnlyConvention: {
      matches: unfilledMatches,
      mismatches: unfilledMismatches,
    },
  },
  maxDiagnosticDelta,
  backtest: {
    before: beforeBacktest,
    after: {
      model: comparison.model,
      on: comparison.on.summary,
      off: comparison.off.summary,
      eventsOn: comparison.on.events.length,
    },
  },
  paper,
};
writeFileSync(dir + "impact.json", JSON.stringify(result, null, 2) + "\n");
writeFileSync(
  dir + "missing-43.csv",
  "utc,timestamp,classification,indexed_trades,minute_candles\n" +
    result.classification
      .map((g: any) =>
        [g.utc, g.timestamp, g.classification, g.trades, g.minuteCount].join(
          ",",
        ),
      )
      .join("\n") +
    "\n",
);
console.log(JSON.stringify({ ...result, classification: undefined }, null, 2));
