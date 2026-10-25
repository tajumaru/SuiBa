import type { MarketDataProvider } from "../../../packages/market-data/src/provider.ts";
import { analyzeBook } from "../../../packages/market-data/src/book-analysis.ts";
import { apiAccess } from "../../../packages/shared/src/api.ts";
import { randomUUID } from "node:crypto";
import {
  atomic,
  profitConfigOf,
  SUI,
  USDC,
  dayKey,
  safeFailure,
  type Candle,
  type CycleEvidence,
  type DexRouter,
  type TradingDecision,
  type QuoteResult,
  type QuoteRequest,
  Decimal,
} from "../../../packages/shared/src/index.ts";
import type { CandidateAudit } from "../../../packages/shared/src/operations.ts";
import { reconcileFill } from "../../../packages/paper-trading/src/reconciliation.ts";
import { OperationMonitor, numericText } from "./operations.ts";
import {
  evaluateSell,
  evaluateBuy,
  paperCosts,
  positionOf,
  strategyExitPrice,
  type ProfitReport,
} from "../../../packages/profit-guard/src/index.ts";
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
import { validateCandles } from "../../../packages/market-data/src/index.ts";
import { ReadOnlySuiClient } from "../../../packages/sui-client/src/index.ts";
import type { ValidationRecorder } from "./validation.ts";
export class BotEngine {
  validation?: ValidationRecorder;
  marketStatus() {
    return this.market.status?.() ?? null;
  }
  private busy = false;
  private paper = new PaperTrading();
  readonly monitor: OperationMonitor;
  constructor(
    readonly db: BotDatabase,
    private market: MarketDataProvider,
    private router: DexRouter,
    readonly sui: Pick<ReadOnlySuiClient, "health" | "status">,
  ) {
    this.monitor = new OperationMonitor(db);
    apiAccess.onTransientFailure = (api, code, failure) =>
      this.monitor.transientFailure(api, code, failure);
    apiAccess.onRateLimit = () => {
      this.monitor.stop("UPSTREAM_HTTP_429");
      db.set("api_cooldowns", apiAccess.snapshot());
    };
  }
  private async getQuote(request: QuoteRequest) {
    const quote = await this.monitor.request("QUOTE", () =>
      this.router.getQuote(request),
    );
    this.monitor.quote(quote);
    return quote;
  }
  async tick() {
    this.db.assertHealthy();
    if (this.busy) return;
    this.busy = true;
    let audit: CandidateAudit | null = null;
    let committed = false;
    const began = Date.now();
    let measuredFrames: Record<number, Candle[]> = {},
      measuredAction: string | null = null,
      measuredError: string | null = null;
    const cycleToken = this.monitor.beginCycle();
    const cycle: CycleEvidence = {
      cycleId: randomUUID(),
      beganAt: began,
      runningAtStart: this.db.runtime().running,
      generationAtStart: cycleToken,
      connectivityAtStart: this.monitor.safety().connectivity,
      analysis: null,
      outcome: "NOT_EVALUATED",
    };
    try {
      this.db.append(
        "cycle_audits",
        randomUUID(),
        { ...cycle, phase: "START" },
        began,
      );
      const now = Date.now();
      const recovering = this.monitor.safety().connectivity !== "HEALTHY";
      const frames: Record<number, Candle[]> = await this.monitor.acquisition(
        async () => {
          await this.monitor.request("HEALTH", () =>
            this.sui.health(recovering),
          );
          if (this.market.frames) return this.market.frames(now);
          const result: Record<number, Candle[]> = {};
          for (const tf of [300, 900, 3600] as const)
            result[tf] = await this.market.candles(tf, now);
          return result;
        },
        cycle.cycleId,
      );
      if (this.market.frames)
        for (const tf of [300, 900, 3600] as const)
          validateCandles(frames[tf], tf, Date.now());
      measuredFrames = frames;
      const source = frames[300][0].source;
      if (
        Object.values(frames).some((rows) =>
          rows.some((x) => x.source !== source),
        )
      )
        throw new Error("MARKET_PAIR_MISMATCH");
      const previousSource =
        this.db.get<string>("market_source") ??
        this.db.candles().at(-1)?.source;
      for (const rows of Object.values(frames)) this.db.saveCandles(rows);
      this.db.set("market_source", source);
      if (previousSource && previousSource !== source) {
        this.db.set("price", null);
        this.db.set("indicators", null);
        this.db.set("profitGuard", null);
        throw new Error("MARKET_SOURCE_CHANGED");
      }
      const c = frames[300],
        last = c.at(-1)!,
        price = last.close;
      validateCandles(c, 300, Date.now());
      this.monitor.market((last.timestamp + 300) * 1000);
      if (this.db.runtime().running && !this.monitor.ledger().ok)
        throw new Error("PAPER_RECONCILIATION_FAILED");
      let recoveryTransition = false;
      if (this.monitor.safety().connectivity !== "HEALTHY") {
        const status = this.marketStatus();
        this.market.assertReady?.(Date.now());
        const qualities = status?.quality;
        const complete =
          status?.source === "DeepBook" &&
          status.healthy &&
          !status.fallback &&
          [300, 900, 3600].every(
            (tf) =>
              qualities?.[tf] &&
              qualities[tf].unresolved === 0 &&
              qualities[tf].fetchedAt >= began,
          ) &&
          status.bookAt != null &&
          Date.now() - status.bookAt <= 10000 &&
          status.diagnostics?.indexerLagMs != null &&
          status.diagnostics.indexerLagMs <= 60000;
        recoveryTransition = this.monitor.recoveryCycle({
          market: complete,
          sui: this.sui.status.healthy && this.sui.status.checkedAt >= began,
        });
      }
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
      let book:
        import("../../../packages/shared/src/index.ts").BookFeatures | null =
        null;
      const snapshot = this.market.bookSnapshot?.() ?? null;
      const observedAt = Date.now();
      try {
        if (snapshot)
          book = analyzeBook(
            snapshot,
            observedAt,
            [
              s.maxOrder / price / 2,
              s.maxOrder / price,
              (s.maxOrder / price) * 2,
            ],
            s.maxSlippage,
          );
      } catch {
        /* Optional analytical input fails closed in the opt-in strategy. */
      }
      this.db.append(
        "book_observations",
        cycle.cycleId,
        { observedAt, healthy: book !== null, book: snapshot },
        observedAt,
      );
      reg.register("rule-based", new RuleBasedStrategy(s));
      const decision = await reg.get(s.strategy).analyze({
        candles: c,
        current,
        previous,
        entryPrice: p.sui > 0 ? p.costBasis / p.sui : null,
        now: Date.now(),
        book,
      });
      cycle.analysis = {
        cycleId: cycle.cycleId,
        runningAtStart: cycle.runningAtStart,
        runningAtAnalysis: this.db.runtime().running,
        ordersAllowedAtAnalysis:
          !recoveryTransition && this.monitor.ordersAllowed(cycleToken),
        generationAtStart: cycleToken,
        generationAtAnalysis: this.monitor.safety().generation,
        connectivityAtAnalysis: this.monitor.safety().connectivity,
      };
      decision.analysisContext = cycle.analysis;
      cycle.outcome = "ANALYZED";
      this.db.recordAnalysis(cycle.cycleId, decision, current, now);
      measuredAction = decision.action;
      this.monitor.analysis();
      this.db.set("price", price);
      this.db.append(
        "portfolio_snapshots",
        randomUUID(),
        { timestamp: now, equity: equity(p, price) },
        now,
      );
      this.monitor.valuation(price, now);
      let sellPreview: QuoteResult | null = null;
      if (p.sui > 0) {
        try {
          sellPreview = await this.getQuote({
            from: SUI,
            to: USDC,
            amountIn: atomic(Math.min(p.sui, s.maxOrder / price), SUI),
            slippage: s.maxSlippage,
            referencePrice: price,
          });
          if (!(await this.router.validateQuote(sellPreview)))
            sellPreview = null;
        } catch {
          sellPreview = null;
        }
        const costs = sellPreview
          ? paperCosts(sellPreview, this.db.settings())
          : {
              additionalFeeUsdc: null,
              gasUsdc: null,
              dexFeeUsdc: null,
              source: "PAPER_MODEL" as const,
            };
        this.db.recordProfit(
          evaluateSell({
            position: positionOf(p),
            quote: sellPreview,
            costs,
            purpose:
              decision.action === "SELL"
                ? (decision.sellPurpose ?? "TAKE_PROFIT")
                : "TAKE_PROFIT",
            config: profitConfigOf(this.db.settings()),
            now: Date.now(),
          }),
        );
      }
      if (recoveryTransition) {
        cycle.outcome = "RECOVERY_CONFIRMATION";
        return;
      }
      if (
        !this.monitor.ordersAllowed(cycleToken) ||
        !runtime.running ||
        runtime.emergency ||
        runtime.error
      ) {
        cycle.outcome = "SAFETY_GATE";
        return;
      }
      if (runtime.lastCandle === last.timestamp) {
        cycle.outcome = "ALREADY_PROCESSED_CANDLE";
        return;
      }
      if (decision.action === "WAIT") {
        cycle.outcome = "STRATEGY_WAIT";
        this.monitor.wait(now);
        this.db.set("runtime", { ...runtime, lastCandle: last.timestamp });
        return;
      }
      const side = decision.action,
        id = `paper:${last.source}:300:${last.timestamp}:${side}`,
        amount =
          side === "BUY" ? s.maxOrder : Math.min(p.sui, s.maxOrder / price);
      audit = {
        id: randomUUID(),
        orderId: id,
        timestamp: now,
        createdAt: now,
        side,
        requestedInputAtomic: atomic(amount, side === "BUY" ? USDC : SUI),
        quantityAtomic: null,
        quotePriceUsdc: null,
        quoteExpiresAt: null,
        acquisitionCostUsdc: numericText(p.costBasisUsdc ?? p.costBasis),
        expectedSaleUsdc: null,
        saleModel: null,
        dexFeeUsdc: null,
        gasUsdc: null,
        additionalFeeUsdc: null,
        buyGasUsdc: null,
        netProfitUsdc: null,
        minProfitUsdc: String(s.minNetProfitUsdc),
        minProfitPct: String(s.minNetProfitPct),
        profitGuard: { evaluated: false, allowed: null, reason: null },
        risk: { status: "NOT_EVALUATED", reasons: [] },
        finalAction: "PENDING",
        reasons: [],
      };
      this.db.putCandidate(audit);
      cycle.outcome = "CANDIDATE";
      if (amount <= 0) {
        this.monitor.finishCandidate({
          ...audit,
          finalAction: "WAIT",
          reasons: ["NO_POSITION"],
        });
        this.reject(id, ["NO_POSITION"], decision, now, last.timestamp);
        return;
      }
      const q =
        side === "SELL" && sellPreview
          ? sellPreview
          : await this.getQuote({
              from: side === "BUY" ? USDC : SUI,
              to: side === "BUY" ? SUI : USDC,
              amountIn: atomic(amount, side === "BUY" ? USDC : SUI),
              slippage: s.maxSlippage,
              referencePrice: price,
            });
      const quantity = side === "BUY" ? q.minAmountOut : q.amountIn;
      audit.quantityAtomic = /^\d+$/.test(quantity) ? quantity : null;
      audit.quoteExpiresAt = Number.isFinite(q.expiresAt) ? q.expiresAt : null;
      try {
        audit.quotePriceUsdc = numericText(
          new Decimal(side === "BUY" ? q.amountIn : q.minAmountOut)
            .div(1e6)
            .div(new Decimal(quantity).div(1e9))
            .toString(),
        );
      } catch {}
      let reverse: QuoteResult | null = null;
      if (side === "BUY") {
        try {
          reverse = await this.getQuote({
            from: SUI,
            to: USDC,
            amountIn: q.minAmountOut,
            slippage: this.db.settings().maxSlippage,
            referencePrice: price,
          });
          audit.reverseQuoteExpiresAt = Number.isFinite(reverse.expiresAt)
            ? reverse.expiresAt
            : null;
          if (!(await this.router.validateQuote(reverse))) reverse = null;
        } catch {
          reverse = null;
        }
      }
      await this.market.refreshForOrder?.();
      const validQuote = await this.router.validateQuote(q);
      const fresh = Date.now();
      const executionSettings = this.db.settings();
      const costs = paperCosts(q, executionSettings);
      const profitAt = (at: number) =>
        side === "SELL"
          ? evaluateSell({
              position: positionOf(p),
              quote: q,
              costs,
              purpose: decision.sellPurpose ?? "TAKE_PROFIT",
              config: profitConfigOf(executionSettings),
              now: at,
            })
          : evaluateBuy({
              buyQuote: q,
              sellQuote: reverse,
              buyCosts: costs,
              sellCosts: reverse
                ? paperCosts(reverse, executionSettings)
                : {
                    additionalFeeUsdc: null,
                    gasUsdc: null,
                    dexFeeUsdc: null,
                    source: "PAPER_MODEL",
                  },
              config: profitConfigOf(executionSettings),
              now: at,
              maxExitUsdc: String(executionSettings.maxOrder),
              strategyTargetPrice: strategyExitPrice(
                positionOf(p),
                q,
                costs,
                executionSettings.takeProfitPct,
              ),
            });
      const profit = profitAt(fresh);
      this.db.recordProfit(profit, decision);
      Object.assign(audit, {
        timestamp: fresh,
        acquisitionCostUsdc: profit.allocatedCostUsdc,
        netProfitUsdc: profit.netProfitUsdc,
        minProfitUsdc: profit.minProfitUsdc,
        minProfitPct: profit.minProfitPct,
        dexFeeUsdc: costs.dexFeeUsdc,
        gasUsdc: costs.gasUsdc,
        additionalFeeUsdc: costs.additionalFeeUsdc,
        buyGasUsdc: profit.buyCosts?.gasUsdc ?? null,
        profitGuard: {
          evaluated: true,
          allowed: profit.allowed,
          reason: profit.reason,
        },
      });
      try {
        audit.expectedSaleUsdc =
          side === "SELL"
            ? new Decimal(q.minAmountOut).div(1e6).toString()
            : reverse && profit.targetPrice
              ? new Decimal(reverse.minAmountOut)
                  .div(1e6)
                  .mul(profit.targetPrice)
                  .div(q.referencePrice)
                  .toDecimalPlaces(6, Decimal.ROUND_FLOOR)
                  .toString()
              : null;
        audit.saleModel =
          side === "SELL" ? "CURRENT_QUOTE" : "PROJECTED_TARGET";
        if (audit.reverseQuoteExpiresAt != null && audit.quoteExpiresAt != null)
          audit.quoteExpiresAt = Math.min(
            audit.quoteExpiresAt,
            audit.reverseQuoteExpiresAt,
          );
        if (
          side === "BUY" &&
          profit.targetPrice &&
          profit.costs?.additionalFeeUsdc != null &&
          profit.costs.gasUsdc != null
        ) {
          const D = Decimal.clone({ precision: 60 }),
            factor = new D(profit.targetPrice).div(q.referencePrice);
          const chunks = D.max(
            1,
            new D(q.minAmountOut)
              .div(1e9)
              .mul(profit.targetPrice)
              .div(executionSettings.maxOrder)
              .ceil(),
          );
          audit.projectedSaleFeeUsdc = new D(profit.costs.additionalFeeUsdc)
            .mul(factor)
            .div(chunks)
            .toDecimalPlaces(6, D.ROUND_CEIL)
            .mul(chunks)
            .toString();
          audit.projectedSaleGasUsdc = new D(profit.costs.gasUsdc)
            .mul(chunks)
            .toString();
        } else if (side === "SELL") {
          audit.projectedSaleFeeUsdc = costs.additionalFeeUsdc;
          audit.projectedSaleGasUsdc = costs.gasUsdc;
        }
      } catch {}
      if (!profit.allowed) {
        this.monitor.finishCandidate({
          ...audit,
          finalAction: "WAIT",
          reasons: [profit.reason],
        });
        this.reject(
          id,
          [`PROFIT_GUARD_${profit.reason}`],
          decision,
          fresh,
          last.timestamp,
        );
        return;
      }
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
      audit.risk = { status: reasons.length ? "REJECTED" : "ALLOWED", reasons };
      if (reasons.length) {
        this.monitor.finishCandidate({
          ...audit,
          finalAction: "WAIT",
          reasons,
        });
        this.reject(id, reasons, decision, fresh, last.timestamp);
        return;
      }
      if (!(await this.router.validateQuote(q)))
        throw new Error("QUOTE_EXPIRED");
      const executionNow = Date.now();
      const finalRuntime = this.db.runtime();
      if (
        !this.monitor.ordersAllowed(cycleToken) ||
        !finalRuntime.running ||
        finalRuntime.emergency ||
        finalRuntime.error
      ) {
        const reasons = [
          finalRuntime.error ??
            (finalRuntime.emergency ? "EMERGENCY_STOP" : "BOT_STOPPED"),
        ];
        this.monitor.finishCandidate({
          ...audit,
          risk: { status: "REJECTED", reasons },
          finalAction: "WAIT",
          reasons,
        });
        this.reject(id, reasons, decision, executionNow, last.timestamp);
        return;
      }
      if (apiAccess.blocked()) throw new Error("API_BACKOFF");
      validateCandles(c, 300, executionNow);
      if (
        q.expiresAt <= executionNow ||
        (reverse && reverse.expiresAt <= executionNow)
      )
        throw new Error("QUOTE_EXPIRED");
      this.market.assertReady?.(executionNow);
      if (!this.monitor.ledger().ok)
        throw new Error("PAPER_RECONCILIATION_FAILED");
      const contextChanged =
        JSON.stringify(this.db.settings()) !==
          JSON.stringify(executionSettings) ||
        JSON.stringify(this.db.portfolio()) !== JSON.stringify(p);
      const finalProfit = profitAt(executionNow);
      const finalReasons = assessRisk({
        side,
        quote: q,
        portfolio: this.db.portfolio(),
        runtime: this.db.runtime(),
        settings: this.db.settings(),
        price,
        marketClosedAt: (last.timestamp + 300) * 1000,
        now: executionNow,
        duplicate: this.db.hasOrder(id),
        pending: 0,
      });
      if (contextChanged) finalReasons.push("EXECUTION_CONTEXT_CHANGED");
      if (!finalProfit.allowed)
        finalReasons.push("PROFIT_GUARD_" + finalProfit.reason);
      if (finalReasons.length) {
        this.monitor.finishCandidate({
          ...audit,
          finalAction: "WAIT",
          reasons: finalReasons,
          risk: { status: "REJECTED", reasons: finalReasons },
        });
        this.reject(id, finalReasons, decision, executionNow, last.timestamp);
        return;
      }
      const fill = this.paper.fill(
        id,
        side,
        q,
        p,
        executionSettings,
        executionNow,
      );
      const check = reconcileFill(
        p,
        fill.portfolio,
        fill.trade,
        q,
        price,
        executionSettings,
      );
      if (!check.ok) {
        this.db.append("paper_checks", randomUUID(), check, fresh);
        throw new Error("PAPER_RECONCILIATION_FAILED");
      }
      this.db.commitFill(
        id,
        { id, side, status: "FILLED", quote: q, profitGuard: profit },
        fill.portfolio,
        fill.trade,
        { ...this.db.runtime(), lastCandle: last.timestamp },
        {
          audit: { ...audit, finalAction: side, reasons: [] },
          check,
          markPrice: price,
          validation: this.validation?.fill(
            this.marketStatus(),
            last.source,
            c,
            audit.quoteExpiresAt ?? q.expiresAt,
            audit.risk.status === "ALLOWED",
            audit.profitGuard.allowed === true,
            executionNow,
          ),
        },
      );
      committed = true;
      cycle.outcome = "FILLED";
      this.monitor.filled(fresh);
      const persisted = reconcileFill(
        p,
        this.db.portfolio(),
        fill.trade,
        q,
        price,
        executionSettings,
      );
      if (!persisted.ok) {
        this.db.append("paper_checks", randomUUID(), persisted, fresh);
        throw new Error("PAPER_RECONCILIATION_FAILED");
      }
    } catch (error) {
      const code =
        error instanceof Error &&
        [
          "PAPER_RECONCILIATION_FAILED",
          "DUPLICATE_ORDER",
          "VALIDATION_RECORD_FAILED",
        ].includes(error.message)
          ? error.message
          : safeFailure(error);
      measuredError = code;
      cycle.outcome = "FAILED";
      if (audit && !committed)
        this.monitor.finishCandidate({
          ...audit,
          timestamp: Date.now(),
          finalAction: "SAFE_STOP",
          reasons: [code],
        });
      this.db.set("decision", { action: "WAIT", reason: code, confidence: 0 });
      if (!this.monitor.transientCycleFailure(code)) {
        this.monitor.failCycle(code);
        this.db.set("runtime", {
          ...this.db.runtime(),
          running: false,
          error: this.db.runtime().error ?? code,
        });
      }
      this.db.append("risk_events", randomUUID(), {
        timestamp: Date.now(),
        reasons: [code],
      });
    } finally {
      const quality = this.market.status?.()?.quality;
      if (quality) this.db.set("market_quality", quality);
      this.monitor.healthy();
      try {
        if (audit && !committed && !measuredError)
          cycle.outcome = "CANDIDATE_REJECTED";
        this.db.append(
          "cycle_audits",
          randomUUID(),
          {
            ...cycle,
            phase: "END",
            endedAt: Date.now(),
            runningAtEnd: this.db.runtime().running,
            action: measuredAction,
            error: measuredError,
            candidateId: audit?.id ?? null,
            orderId: audit?.orderId ?? null,
          },
          Date.now(),
        );
        this.validation?.cycle(
          this.marketStatus(),
          measuredFrames,
          measuredAction,
          measuredError,
          began,
          Date.now(),
          cycle,
        );
      } catch {
        this.validation?.fault("VALIDATION_RECORD_FAILED");
        this.db.set("runtime", {
          ...this.db.runtime(),
          running: false,
          error: "VALIDATION_RECORD_FAILED",
        });
        throw new Error("VALIDATION_RECORD_FAILED");
      } finally {
        this.busy = false;
      }
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
  snapshot(options: { light?: boolean } = {}) {
    const decision = this.monitor.displayDecision();
    const p = this.db.portfolio(),
      price = this.db.get<number>("price") ?? null,
      trades = this.db.history<Fill>("paper_trades", 10000),
      values = this.db
        .history<{ equity: number }>("portfolio_snapshots", 10000)
        .reverse()
        .map((x) => x.equity);
    return {
      marketData: this.market.status?.() ?? null,
      marketQuality: this.db.get("market_quality") ?? null,
      mode: "PAPER",
      runtime: this.db.runtime(),
      safety: this.monitor.safetySnapshot(),
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
      decision,
      indicators: this.db.get("indicators") ?? null,
      settings: this.db.settings(),
      profitGuard: this.db.get<ProfitReport>("profitGuard") ?? null,
      acquisitionCostUsdc: positionOf(p).costUsdc,
      acquisitionFees:
        trades.find((t) => t.side === "BUY")?.acquisition ?? null,
      trades: options.light ? [] : trades.slice(0, 200),
      orders: options.light ? [] : this.db.history("paper_orders"),
      riskEvents: options.light ? [] : this.db.history("risk_events"),
      candles: options.light ? [] : this.db.candles(),
      candlesByTimeframe: {
        300: options.light ? [] : this.db.candles(300),
        900: options.light ? [] : this.db.candles(900),
        3600: options.light ? [] : this.db.candles(3600),
      },
      strategies: [
        { id: "rule-based", available: true },
        { id: "deepseek", available: false },
      ],
    };
  }
}
