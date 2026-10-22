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
  constructor(
    private engine: BotEngine,
    private db: BotDatabase,
  ) {}
  frame(tf: Timeframe) {
    const candles = this.db.candles(tf),
      version = digest(canonicalFrame(candles));
    const history = this.frames.get(tf) ?? [];
    if (history[0]?.version !== version) {
      history.unshift({ version, candles });
      history.splice(3);
      this.frames.set(tf, history);
    }
    return history[0];
  }
  recordsData() {
    return {
      trades: this.db.history<Fill>("paper_trades", 200),
      orders: this.db.history("paper_orders"),
      riskEvents: this.db.history("risk_events"),
    };
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
    const records = this.recordsData();
    return {
      schema: 1 as const,
      generatedAt: Date.now(),
      summary,
      frames: {
        300: this.frame(300).version,
        900: this.frame(900).version,
        3600: this.frame(3600).version,
      },
      recordsVersion: digest(JSON.stringify(records)),
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
    const records = this.recordsData();
    return {
      schema: 1 as const,
      version: digest(JSON.stringify(records)),
      records,
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
