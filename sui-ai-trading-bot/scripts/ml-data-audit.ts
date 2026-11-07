/** Offline summaries only. Never construct BotDatabase: its constructor writes. */
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Decimal } from "decimal.js";

const eventTables = [
  "strategy_decisions",
  "technical_indicators",
  "operation_candidates",
  "cycle_audits",
  "paper_orders",
  "paper_trades",
  "portfolio_snapshots",
  "operation_events",
  "bot_settings",
  "validation_events",
  "sui_observations",
] as const;
type Row = { id: string; timestamp: number; value: Record<string, unknown> };
type Window = { from: number; until: number };
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function decimal(v: unknown): Decimal | null {
  if (!(typeof v === "string" || finite(v)) || v === "") return null;
  try {
    const n = new Decimal(v);
    return n.isFinite() ? n : null;
  } catch {
    return null;
  }
}
const indicators = [
  "ema20",
  "ema50",
  "rsi",
  "macd",
  "signal",
  "histogram",
  "atr",
  "volumeChange",
  "priceChange",
];
const indicatorComplete = (v: unknown) =>
  object(v) && indicators.every((k) => finite(v[k]));

export function auditDatabase(file: string, window: Window) {
  if (
    !Number.isSafeInteger(window.from) ||
    !Number.isSafeInteger(window.until) ||
    window.from < 0 ||
    window.until <= window.from
  )
    throw Error("INVALID_AUDIT_WINDOW");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;");
    const names = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    const inventory: Record<
      string,
      {
        rows: number;
        first: number | null;
        last: number | null;
        malformed: number;
      }
    > = {};
    const rows: Record<string, Row[]> = {};
    for (const table of eventTables) {
      if (!names.has(table)) {
        rows[table] = [];
        continue;
      }
      const totals = db
        .prepare(
          `SELECT COUNT(*) AS rows, MIN(timestamp) AS first, MAX(timestamp) AS last FROM ${table} WHERE timestamp>=? AND timestamp<?`,
        )
        .get(window.from, window.until) as {
        rows: number;
        first: number | null;
        last: number | null;
      };
      // Refuse excessive input instead of silently training/reporting on a truncated tail.
      if (totals.rows > 200000) throw Error("AUDIT_WINDOW_TOO_LARGE");
      const selected = db
        .prepare(
          `SELECT id,timestamp,json FROM ${table} WHERE timestamp>=? AND timestamp<? ORDER BY timestamp,id`,
        )
        .all(window.from, window.until) as {
        id: string;
        timestamp: number;
        json: string;
      }[];
      const parsed: Row[] = [];
      let malformed = 0;
      for (const r of selected) {
        try {
          const value: unknown = JSON.parse(r.json);
          if (!object(value)) throw Error("INVALID_ROW");
          parsed.push({ id: r.id, timestamp: r.timestamp, value });
        } catch {
          malformed++;
        }
      }
      inventory[table] = { ...totals, malformed };
      rows[table] = parsed;
    }
    const decisions = rows.strategy_decisions;
    const techIds = new Set(
      rows.technical_indicators
        .filter((r) => indicatorComplete(r.value))
        .map((r) => r.id),
    );
    let evidenceComplete = 0,
      closedAtDecision = 0,
      activeAtAnalysis = 0,
      duplicateBuySignals = 0;
    const uniqueBuySignals = new Set<string>();
    const actions: Record<string, number> = {
      BUY: 0,
      SELL: 0,
      WAIT: 0,
      OTHER: 0,
    };
    for (const r of decisions) {
      const d = r.value,
        e = d.evidence;
      const action = ["BUY", "SELL", "WAIT"].includes(String(d.action))
        ? String(d.action)
        : "OTHER";
      actions[action]++;
      if (
        object(d.analysisContext) &&
        d.analysisContext.runningAtAnalysis === true &&
        d.analysisContext.ordersAllowedAtAnalysis === true
      )
        activeAtAnalysis++;
      if (!object(e) || !object(e.inputs)) continue;
      if (
        e.version === 1 &&
        indicatorComplete(e.inputs.current) &&
        indicatorComplete(e.inputs.previous) &&
        finite(e.inputs.price) &&
        e.inputs.price > 0 &&
        finite(e.inputs.latestVolume) &&
        finite(e.inputs.previousVolume) &&
        (e.inputs.entryPrice === null ||
          (finite(e.inputs.entryPrice) && e.inputs.entryPrice > 0)) &&
        finite(e.candleTimestamp) &&
        Number.isSafeInteger(e.candleTimestamp) &&
        e.candleTimestamp >= 0 &&
        finite(e.previousCandleTimestamp) &&
        e.previousCandleTimestamp < e.candleTimestamp &&
        finite(e.evaluatedAt) &&
        (e.candleTimestamp + 300) * 1000 <= e.evaluatedAt &&
        e.evaluatedAt <= r.timestamp &&
        object(e.thresholds) &&
        [
          "oversold",
          "overbought",
          "maxVolumeChange",
          "stopLossPct",
          "takeProfitPct",
        ].every((k) => finite((e.thresholds as Record<string, unknown>)[k])) &&
        object(e.conditions) &&
        Object.keys(e.conditions).length > 0 &&
        Object.values(e.conditions).every((v) => typeof v === "boolean") &&
        typeof e.selectedRule === "string"
      )
        evidenceComplete++;
      if (
        finite(e.candleTimestamp) &&
        (e.candleTimestamp + 300) * 1000 <= r.timestamp
      )
        closedAtDecision++;
      if (action === "BUY" && finite(e.candleTimestamp)) {
        const key = `${e.candleTimestamp}:${String(e.selectedRule)}`;
        if (uniqueBuySignals.has(key)) duplicateBuySignals++;
        uniqueBuySignals.add(key);
      }
    }
    const endRows = rows.cycle_audits.filter((r) => r.value.phase === "END");
    const decisionIds = new Set(decisions.map((r) => r.id));
    const candidateIds = new Set(rows.operation_candidates.map((r) => r.id));
    const candidateOrderIds = new Set(
      rows.operation_candidates.map((r) => r.value.orderId),
    );
    const orderIds = new Set(rows.paper_orders.map((r) => r.id));
    const linkedEnds = endRows.filter(
      (r) =>
        typeof r.value.candidateId === "string" &&
        candidateIds.has(r.value.candidateId) &&
        typeof r.value.cycleId === "string" &&
        decisionIds.has(r.value.cycleId),
    );
    const trades = rows.paper_trades;
    const sells = trades.filter((r) => r.value.side === "SELL");
    const sellPnls = sells.map((r) =>
      decimal(r.value.realizedProfitUsdc ?? r.value.pnl),
    );
    const feeValues = trades.map((r) => {
      const fee = decimal(r.value.fee);
      return fee?.gte(0) ? fee : null;
    });
    const sum = (values: (Decimal | null)[]) =>
      values.some((v) => v === null)
        ? null
        : values
            .reduce<Decimal>((a, v) => a.plus(v!), new Decimal(0))
            .toString();
    const snapshots = rows.portfolio_snapshots.filter(
      (r) => finite(r.value.equity) && r.value.equity >= 0,
    );
    let peak = 0,
      drawdown = 0,
      maxSampleGapMs = 0;
    for (let i = 0; i < snapshots.length; i++) {
      const equity = snapshots[i].value.equity as number;
      peak = Math.max(peak, equity);
      if (peak > 0) drawdown = Math.max(drawdown, (peak - equity) / peak);
      if (i)
        maxSampleGapMs = Math.max(
          maxSampleGapMs,
          snapshots[i].timestamp - snapshots[i - 1].timestamp,
        );
    }
    const stops: Record<string, number> = {};
    for (const r of rows.operation_events.filter(
      (r) => r.value.kind === "STOP",
    )) {
      const code =
        typeof r.value.code === "string" &&
        /^[A-Z0-9_]{1,80}$/.test(r.value.code)
          ? r.value.code
          : "OTHER";
      stops[code] = (stops[code] ?? 0) + 1;
    }
    const candleInventory = names.has("market_candles")
      ? db
          .prepare(
            "SELECT timeframe,COUNT(*) AS rows,MIN(timestamp) AS firstOpenSeconds,MAX(timestamp) AS lastOpenSeconds FROM market_candles GROUP BY timeframe ORDER BY timeframe",
          )
          .all()
      : [];
    const malformed = Object.values(inventory).reduce(
      (n, t) => n + t.malformed,
      0,
    );
    const malformedTrades = inventory.paper_trades?.malformed ?? 0;
    return {
      version: 1,
      window: { ...window, semantics: "[from, until), epoch milliseconds" },
      inventory,
      missingTables: [...eventTables, "market_candles"].filter(
        (t) => !names.has(t),
      ),
      candlesAllHistory: candleInventory,
      decisionCoverage: {
        rows: decisions.length,
        actions,
        evidenceComplete,
        closedAtDecision,
        indicatorsJoinedByCycleId: decisions.filter((r) => techIds.has(r.id))
          .length,
        activeAtAnalysis,
        uniqueBuySignalsWithCandleEvidence: uniqueBuySignals.size,
        duplicateBuySignals,
        candidateRows: rows.operation_candidates.length,
        candidatesLinkedThroughCycleEnd: new Set(
          linkedEnds.map((r) => r.value.candidateId),
        ).size,
        tradesJoinedToOrder: trades.filter((r) => orderIds.has(r.id)).length,
        tradesJoinedToCandidate: trades.filter((r) =>
          candidateOrderIds.has(r.value.orderId),
        ).length,
      },
      baseline: {
        interpretation:
          "PAPER observed-window summary, not full-run return or live execution proof",
        rawTradeRows: inventory.paper_trades?.rows ?? 0,
        parsedTrades: trades.length,
        buys: trades.filter((r) => r.value.side === "BUY").length,
        sells: sells.length,
        knownSellOutcomes: sellPnls.filter((v) => v !== null).length,
        realizedPnlOnWindowSellsUsdc: malformedTrades ? null : sum(sellPnls),
        sellFillWinRate:
          !malformedTrades && sells.length && sellPnls.every((v) => v !== null)
            ? sellPnls.filter((v) => v!.gt(0)).length / sells.length
            : null,
        additionalFeesAndGasUsdc: malformedTrades ? null : sum(feeValues),
        unknownFeeTrades: feeValues.filter((v) => v === null).length,
        equitySamples: snapshots.length,
        firstEquityAt: snapshots[0]?.timestamp ?? null,
        lastEquityAt: snapshots.at(-1)?.timestamp ?? null,
        observedEquityChangeUsdc:
          snapshots.length >= 2
            ? new Decimal(snapshots.at(-1)!.value.equity as number)
                .minus(snapshots[0].value.equity as number)
                .toString()
            : null,
        sampledMaxDrawdownPct:
          snapshots.length >= 2 && peak > 0 ? drawdown * 100 : null,
        maxEquitySampleGapMs: snapshots.length >= 2 ? maxSampleGapMs : null,
        invalidEquitySamples:
          rows.portfolio_snapshots.length - snapshots.length,
        stopEvents: stops,
        fullRunNetPnlUsdc: null,
      },
      trainingReady: false,
      blockers: [
        "RUN_ID_BUILD_PAIR_SETTINGS_AND_BOUNDARIES_REQUIRE_EXTERNAL_MANIFEST",
        "POINT_IN_TIME_MARKET_AND_COUNTERFACTUAL_EXIT_LABELS_NOT_VERIFIED",
        ...(malformed ? ["MALFORMED_JSON_ROWS"] : []),
        ...(decisions.length === 0 ? ["NO_DECISIONS_IN_WINDOW"] : []),
        ...(evidenceComplete !== decisions.length
          ? ["INCOMPLETE_DECISION_EVIDENCE"]
          : []),
      ],
    };
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}

function timestamp(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw Error("ISO_TIMESTAMP_WITH_TIMEZONE_REQUIRED");
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw Error("INVALID_TIMESTAMP");
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [file, from, until, ...extra] = process.argv.slice(2);
  if (!file || extra.length)
    throw Error(
      "USAGE: node --import tsx scripts/ml-data-audit.ts SNAPSHOT.sqlite FROM_ISO UNTIL_ISO",
    );
  const report = auditDatabase(resolve(file), {
    from: timestamp(from),
    until: timestamp(until),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
