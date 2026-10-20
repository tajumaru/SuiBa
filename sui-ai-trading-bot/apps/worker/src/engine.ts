import { randomUUID } from "node:crypto";
import {
  atomic,
  SUI,
  USDC,
  dayKey,
  safeFailure,
  type Candle,
  type DexRouter,
  type TradingDecision,
} from "../../../packages/shared/src/index.ts";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import { calculate } from "../../../packages/indicators/src/index.ts";
import {
  RuleBasedStrategy,
  StrategyRegistry,
} from "../../../packages/strategy-engine/src/index.ts";
import { assessRisk } from "../../../packages/risk-engine/src/index.ts";
import {
  PaperTrading,
  type Fill,
} from "../../../packages/paper-trading/src/index.ts";
import { equity, metrics } from "../../../packages/portfolio/src/index.ts";
import { GeckoMarketData } from "../../../packages/market-data/src/index.ts";
import { ReadOnlySuiClient } from "../../../packages/sui-client/src/index.ts";
export class BotEngine {
  private busy = false;
  private paper = new PaperTrading();
  constructor(
    readonly db: BotDatabase,
    private market: Pick<GeckoMarketData, "candles">,
    private router: DexRouter,
    readonly sui: Pick<ReadOnlySuiClient, "health" | "status">,
  ) {}
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      await this.sui.health();
      const frames: Record<number, Candle[]> = {};
      for (const tf of [300, 900, 3600] as const) {
        const c = await this.market.candles(tf, now);
        this.db.saveCandles(c);
        frames[tf] = c;
      }
      const c = frames[300],
        last = c.at(-1)!,
        price = last.close;
      let p = this.db.portfolio();
      if (p.day !== dayKey(now)) {
        p = {
          ...p,
          day: dayKey(now),
          dayStartEquity: equity(p, price),
          dailyBought: 0,
        };
        this.db.set("portfolio", p);
      }
      const s = this.db.settings(),
        runtime = this.db.runtime(),
        current = calculate(c),
        previous = calculate(c.slice(0, -1));
      const reg = new StrategyRegistry();
      reg.register("rule-based", new RuleBasedStrategy(s));
      const decision = await reg.get(s.strategy).analyze({
        candles: c,
        current,
        previous,
        entryPrice: p.sui > 0 ? p.costBasis / p.sui : null,
        now,
      });
      this.db.recordAnalysis(randomUUID(), decision, current, now);
      this.db.set("price", price);
      this.db.append(
        "portfolio_snapshots",
        randomUUID(),
        { timestamp: now, equity: equity(p, price) },
        now,
      );
      if (
        !runtime.running ||
        runtime.emergency ||
        runtime.error ||
        runtime.lastCandle === last.timestamp
      )
        return;
      if (decision.action === "WAIT") {
        this.db.set("runtime", { ...runtime, lastCandle: last.timestamp });
        return;
      }
      const side = decision.action,
        id = `paper:${last.source}:300:${last.timestamp}:${side}`,
        amount =
          side === "BUY" ? s.maxOrder : Math.min(p.sui, s.maxOrder / price);
      if (amount <= 0) {
        this.reject(id, ["NO_POSITION"], decision, now, last.timestamp);
        return;
      }
      const q = await this.router.getQuote({
        from: side === "BUY" ? USDC : SUI,
        to: side === "BUY" ? SUI : USDC,
        amountIn: atomic(amount, side === "BUY" ? USDC : SUI),
        slippage: s.maxSlippage,
        referencePrice: price,
      });
      const validQuote = await this.router.validateQuote(q);
      const fresh = Date.now();
      const executionSettings = this.db.settings();
      const reasons = assessRisk({
        side,
        quote: q,
        portfolio: p,
        runtime: this.db.runtime(),
        settings: executionSettings,
        price,
        marketClosedAt: (last.timestamp + 300) * 1000,
        now: fresh,
        duplicate: this.db.hasOrder(id),
        pending: 0,
      });
      if (!validQuote) reasons.push("QUOTE_INVALID");
      if (reasons.length) {
        this.reject(id, reasons, decision, fresh, last.timestamp);
        return;
      }
      const fill = this.paper.fill(id, side, q, p, executionSettings, fresh);
      this.db.commitFill(
        id,
        { id, side, status: "FILLED", quote: q },
        fill.portfolio,
        fill.trade,
        { ...this.db.runtime(), lastCandle: last.timestamp },
      );
    } catch (error) {
      const code = safeFailure(error);
      this.db.set("runtime", {
        ...this.db.runtime(),
        running: false,
        error: code,
      });
      this.db.append("risk_events", randomUUID(), {
        timestamp: Date.now(),
        reasons: [code],
      });
    } finally {
      this.busy = false;
    }
  }
  private reject(
    id: string,
    reasons: string[],
    decision: TradingDecision,
    now: number,
    candle: number,
  ) {
    this.db.transaction(() => {
      if (!this.db.hasOrder(id))
        this.db.append(
          "paper_orders",
          id,
          {
            id,
            status: "REJECTED",
            side: decision.action,
            reasons,
            timestamp: now,
          },
          now,
        );
      this.db.append(
        "risk_events",
        randomUUID(),
        { timestamp: now, reasons },
        now,
      );
      this.db.set("runtime", { ...this.db.runtime(), lastCandle: candle });
    });
  }
  snapshot() {
    const p = this.db.portfolio(),
      price = this.db.get<number>("price") ?? null,
      trades = this.db.history<Fill>("paper_trades", 10000),
      values = this.db
        .history<{ equity: number }>("portfolio_snapshots", 10000)
        .reverse()
        .map((x) => x.equity);
    return {
      mode: "PAPER",
      runtime: this.db.runtime(),
      connection: this.sui.status,
      price,
      portfolio: p,
      equity: price === null ? null : equity(p, price),
      pnl: price === null ? null : equity(p, price) - p.initialEquity,
      dailyPnl: price === null ? null : equity(p, price) - p.dayStartEquity,
      unrealized: price === null ? null : p.sui * price - p.costBasis,
      todayTrades: trades.filter(
        (x) => dayKey(x.timestamp) === dayKey(Date.now()),
      ).length,
      metrics: metrics(
        values,
        trades.flatMap((x) => (x.pnl === null ? [] : [x.pnl])),
      ),
      decision: this.db.get("decision") ?? null,
      indicators: this.db.get("indicators") ?? null,
      settings: this.db.settings(),
      trades: trades.slice(0, 200),
      orders: this.db.history("paper_orders"),
      riskEvents: this.db.history("risk_events"),
      candles: this.db.candles(),
      candlesByTimeframe: {
        300: this.db.candles(300),
        900: this.db.candles(900),
        3600: this.db.candles(3600),
      },
      strategies: [
        { id: "rule-based", available: true },
        { id: "deepseek", available: false },
      ],
    };
  }
}
