import { createHash } from "node:crypto";
import { canonicalFrame } from "../../../packages/shared/src/dashboard-wire.ts";
import type { Candle, Timeframe } from "../../../packages/shared/src/index.ts";
import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import type { BotEngine } from "./engine.ts";
import type { BotDatabase } from "../../../packages/database/src/index.ts";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export class DashboardService {
  private frames = new Map<number, { version: string; candles: Candle[] }[]>();
  private frameVersions = new Map<number, string>();
  private recordCache: {
    token: string;
    value: ReturnType<DashboardService["readRecords"]>;
    version: string;
  } | null = null;
  constructor(
    private engine: BotEngine,
    private db: BotDatabase,
  ) {}
  frame(tf: Timeframe) {
    return this.frameAtVersion(tf, this.db.displayVersion());
  }
  private frameAtVersion(tf: Timeframe, token: string) {
    if (this.frameVersions.get(tf) === token) return this.frames.get(tf)![0];
    const candles = this.db.candles(tf),
      version = digest(canonicalFrame(candles));
    const history = this.frames.get(tf) ?? [];
    if (history[0]?.version !== version) {
      history.unshift({ version, candles });
      history.splice(3);
      this.frames.set(tf, history);
    }
    this.frameVersions.set(tf, token);
    return history[0];
  }
  private readRecords() {
    return {
      trades: this.db.history<Fill>("paper_trades", 200),
      orders: this.db.history("paper_orders"),
      riskEvents: this.db.history("risk_events"),
    };
  }
  private cachedRecords(token = this.db.displayVersion()) {
    if (this.recordCache?.token !== token) {
      const value = this.readRecords();
      this.recordCache = {
        token,
        value,
        version: digest(JSON.stringify(value)),
      };
    }
    return this.recordCache;
  }
  recordsData() {
    return this.cachedRecords().value;
  }
  summary() {
    const {
      candles,
      candlesByTimeframe,
      trades,
      orders,
      riskEvents,
      ...summary
    } = this.engine.snapshot({ light: true });
    const token = this.db.displayVersion(),
      records = this.cachedRecords(token);
    return {
      schema: 1 as const,
      generatedAt: Date.now(),
      summary,
      frames: {
        300: this.frameAtVersion(300, token).version,
        900: this.frameAtVersion(900, token).version,
        3600: this.frameAtVersion(3600, token).version,
      },
      recordsVersion: records.version,
    };
  }
  candles(tf: Timeframe, baseVersion: string | null) {
    const current = this.frame(tf),
      base = (this.frames.get(tf) ?? []).find((f) => f.version === baseVersion);
    const reset =
      !base || base.candles[0]?.source !== current.candles[0]?.source;
    const old = new Map((base?.candles ?? []).map((c) => [c.timestamp, c])),
      present = new Set(current.candles.map((c) => c.timestamp));
    return {
      schema: 1 as const,
      timeframe: tf,
      baseVersion,
      version: current.version,
      reset,
      upserts: reset
        ? current.candles
        : current.candles.filter(
            (c) =>
              !old.has(c.timestamp) ||
              canonicalFrame([c]) !== canonicalFrame([old.get(c.timestamp)!]),
          ),
      removed: reset
        ? []
        : (base?.candles ?? [])
            .filter((c) => !present.has(c.timestamp))
            .map((c) => c.timestamp),
    };
  }
  records() {
    const records = this.cachedRecords();
    return {
      schema: 1 as const,
      version: records.version,
      records: records.value,
    };
  }
}

export function acceptsGzip(header: string | undefined) {
  return (header ?? "").split(",").some((value) => {
    const [encoding, ...parameters] = value.trim().split(";");
    const q =
      parameters.find((p) => p.trim().startsWith("q="))?.split("=")[1] ?? "1";
    return encoding.toLowerCase() === "gzip" && Number(q) > 0;
  });
}
