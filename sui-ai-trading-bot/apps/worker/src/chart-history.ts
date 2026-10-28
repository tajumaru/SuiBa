import { verifiedDisplayRepairs } from "../../../packages/shared/src/chart-gap-audit.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseDeepBook } from "../../../packages/market-data/src/deepbook.ts";
import { retryAfter } from "../../../packages/shared/src/api.ts";
import type {
  Candle,
  Timeframe,
  TradingPair,
} from "../../../packages/shared/src/index.ts";
export interface HistoryQuery {
  timeframe: Timeframe;
  from: number;
  to: number;
}
export function historyQuery(
  params: URLSearchParams,
  now = Date.now(),
): HistoryQuery {
  const timeframe = Number(params.get("timeframe")),
    from = Number(params.get("from")),
    to = Number(params.get("to"));
  if (
    ![300, 900, 3600].includes(timeframe) ||
    ![from, to].every(Number.isSafeInteger) ||
    from <= 0 ||
    to <= from ||
    to - from > 12 * 86400 ||
    to * 1000 > now ||
    from * 1000 < now - 14 * 86400000 ||
    from % timeframe ||
    to % timeframe
  )
    throw Error("INVALID_CHART_RANGE");
  return { timeframe: timeframe as Timeframe, from, to };
}
export interface HistoryResult {
  candles: Candle[];
  from: number;
  to: number;
  timeframe: number;
  source: string;
  fetchedAt: number;
  missing: number;
  error: string | null;
  nextRetryAt: number | null;
  requests: number;
  cacheHit: boolean;
}
export class ChartHistoryStore {
  private db: DatabaseSync;
  private lastRequest = 0;
  constructor(
    path: string,
    private deps: {
      fetch: typeof fetch;
      now: () => number;
      sleep: (ms: number) => Promise<void>;
      gate: () => Promise<boolean>;
    } = {
      fetch,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      gate: async () => true,
    },
    readonly pair: TradingPair = "SUI_USDC",
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL;PRAGMA busy_timeout=100;CREATE TABLE IF NOT EXISTS candles(tf INTEGER,ts INTEGER,json TEXT,PRIMARY KEY(tf,ts));CREATE TABLE IF NOT EXISTS coverage(tf INTEGER,a INTEGER,b INTEGER,at INTEGER,PRIMARY KEY(tf,a,b));CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER);",
    );
  }
  close() {
    this.db.close();
  }
  seed(candles: Candle[]) {
    this.db.exec("BEGIN");
    try {
      for (const c of candles)
        if (
          c.source.startsWith(`DeepBook:${this.pair}:USDC`) &&
          [300, 900, 3600].includes(c.timeframe) &&
          c.timestamp > 0
        )
          this.db
            .prepare(
              "INSERT INTO candles VALUES(?,?,?) ON CONFLICT(tf,ts) DO UPDATE SET json=excluded.json",
            )
            .run(c.timeframe, c.timestamp, JSON.stringify(c));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async get(q: HistoryQuery, signal?: AbortSignal): Promise<HistoryResult> {
    let requests = 0,
      error: string | null = null;
    const now = this.deps.now();
    const rows = this.db
      .prepare("SELECT a,b FROM coverage WHERE tf=? AND at>?")
      .all(q.timeframe, now - 6 * 3600000) as { a: number; b: number }[];
    const ranges = rows.sort((a, b) => a.a - b.a);
    let cursor = q.from;
    const missingRanges: { a: number; b: number }[] = [];
    for (const r of ranges) {
      if (r.b <= cursor) continue;
      if (r.a > cursor)
        missingRanges.push({ a: cursor, b: Math.min(q.to, r.a) });
      cursor = Math.max(cursor, r.b);
      if (cursor >= q.to) break;
    }
    if (cursor < q.to) missingRanges.push({ a: cursor, b: q.to });
    let nextRetryAt =
      (
        this.db.prepare("SELECT value FROM meta WHERE key='cooldown'").get() as
          { value: number } | undefined
      )?.value ?? null;
    try {
      if (nextRetryAt != null && nextRetryAt > now && missingRanges.length)
        throw Error("CHART_BACKOFF");
      let pages = 0;
      for (const range of missingRanges) {
        let until = range.b;
        while (until > range.a) {
          if (++pages > 5 || requests >= 6) throw Error("CHART_PAGE_LIMIT");
          signal?.throwIfAborted();
          const interval = { 300: "5m", 900: "15m", 3600: "1h" }[q.timeframe];
          const path = `/ohclv/${this.pair}?interval=${interval}&start_time=${range.a * 1000}&end_time=${until * 1000 - 1}&limit=1000`;
          let data: ReturnType<typeof parseDeepBook> | undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            const wait = Math.max(0, this.lastRequest + 2500 - this.deps.now());
            if (wait) await this.deps.sleep(wait);
            signal?.throwIfAborted();
            if (!(await this.deps.gate()))
              throw Error("CHART_DEFERRED_FOR_MARKET");
            if (requests >= 6) throw Error("CHART_PAGE_LIMIT");
            this.lastRequest = this.deps.now();
            requests++;
            try {
              const response = await this.deps.fetch(
                "https://deepbook-indexer.mainnet.mystenlabs.com" + path,
                {
                  signal: signal
                    ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
                    : AbortSignal.timeout(8000),
                },
              );
              if (!response.ok) {
                if (response.status === 429) {
                  const delay =
                    retryAfter(
                      response.headers.get("retry-after"),
                      this.deps.now(),
                    ) ?? 60000;
                  nextRetryAt = this.deps.now() + delay;
                  this.db
                    .prepare("INSERT OR REPLACE INTO meta VALUES('cooldown',?)")
                    .run(nextRetryAt);
                  throw Error("CHART_HTTP_429");
                }
                throw Error("CHART_HTTP_" + response.status);
              }
              data = parseDeepBook(
                await response.json(),
                q.timeframe,
                this.deps.now(),
                this.pair,
              );
              break;
            } catch (e) {
              const code =
                e instanceof Error ? e.message : "CHART_NETWORK_ERROR";
              if (
                code === "CHART_HTTP_429" ||
                attempt === 1 ||
                signal?.aborted ||
                (/CHART_HTTP_/.test(code) && !/^CHART_HTTP_50[234]$/.test(code))
              )
                throw e;
              await this.deps.sleep(1000 + Math.floor(Math.random() * 251));
            }
          }
          if (!data) throw Error("CHART_NETWORK_ERROR");
          if (data.length > 1000) throw Error("CHART_RESPONSE_LIMIT");
          if (data.some((c) => c.timestamp < range.a || c.timestamp >= until))
            throw Error("CHART_RANGE_MISMATCH");
          const earliest = data[0]?.timestamp ?? range.a;
          const coveredFrom = data.length < 1000 ? range.a : earliest;
          if (coveredFrom >= until) throw Error("CHART_PAGING_STALLED");
          this.db.exec("BEGIN");
          try {
            for (const c of data) {
              const candle = {
                ...c,
                provenance: {
                  origin: "ORIGINAL",
                  upstream: "DeepBook Indexer",
                  pair: this.pair,
                  fetchedAt: this.deps.now(),
                  timeframe: q.timeframe,
                  evidence: [path],
                },
              };
              this.db
                .prepare(
                  "INSERT INTO candles VALUES(?,?,?) ON CONFLICT(tf,ts) DO UPDATE SET json=excluded.json WHERE json_extract(candles.json, '$.provenance.origin')='NO_INDEXED_TRADES'",
                )
                .run(q.timeframe, c.timestamp, JSON.stringify(candle));
            }
            this.db
              .prepare("INSERT OR REPLACE INTO coverage VALUES(?,?,?,?)")
              .run(q.timeframe, coveredFrom, until, this.deps.now());
            this.db.exec("COMMIT");
          } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
          }
          until = coveredFrom;
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      error = signal?.aborted
        ? "CHART_CANCELLED"
        : /^CHART_[A-Z_0-9]+$/.test(message)
          ? message
          : /timeout/i.test(message)
            ? "CHART_TIMEOUT"
            : "CHART_FETCH_FAILED";
    }
    // These fixed historical repairs were generated with the unchanged verifier at their recorded evidence time.
    // Only fill still-absent display rows after successful coverage; never touch the market database.
    if (!error && q.timeframe === 300)
      for (const c of this.pair === "SUI_USDC" ? verifiedDisplayRepairs : [])
        if (c.timestamp >= q.from && c.timestamp < q.to)
          this.db
            .prepare(
              "INSERT INTO candles VALUES(?,?,?) ON CONFLICT(tf,ts) DO NOTHING",
            )
            .run(300, c.timestamp, JSON.stringify(c));
    // Only this isolated cache is pruned; market/validation databases are never opened here.
    this.db
      .prepare("DELETE FROM candles WHERE ts<?")
      .run(Math.floor(this.deps.now() / 1000) - 14 * 86400);
    this.db
      .prepare("DELETE FROM coverage WHERE at<?")
      .run(this.deps.now() - 6 * 3600000);
    for (const tf of [300, 900, 3600])
      this.db
        .prepare(
          "DELETE FROM candles WHERE tf=? AND ts NOT IN (SELECT ts FROM candles WHERE tf=? ORDER BY ts DESC LIMIT 6000)",
        )
        .run(tf, tf);
    const candles = (
      this.db
        .prepare(
          "SELECT json FROM candles WHERE tf=? AND ts>=? AND ts<? ORDER BY ts LIMIT 4096",
        )
        .all(q.timeframe, q.from, q.to) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as Candle);
    return {
      candles,
      ...q,
      source: "DeepBook Indexer（表示専用履歴）",
      fetchedAt: this.deps.now(),
      missing: Math.max(0, (q.to - q.from) / q.timeframe - candles.length),
      error,
      nextRetryAt,
      requests,
      cacheHit: requests === 0 && !error,
    };
  }
}
