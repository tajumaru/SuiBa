import { apiFetch } from "./api.ts";
import { z } from "zod";
import { Decimal } from "decimal.js";
import { normalizeStructTag } from "@mysten/sui/utils";
export { Decimal };
// Never persist raw upstream exceptions, which may contain URLs or credentials.
export function safeFailure(error: unknown) {
  const allowed = new Set([
    "SUI_READ_FAILED",
    "API_BACKOFF",
    "API_RETRIES_EXHAUSTED",
    "API_CANCELLED",
    "QUOTE_EXPIRED",
    "UPSTREAM_TIMEOUT",
    "UPSTREAM_CONNECT_TIMEOUT",
    "UPSTREAM_HEADERS_TIMEOUT",
    "UPSTREAM_BODY_TIMEOUT",
    "UPSTREAM_DNS_FAILED",
    "UPSTREAM_TLS_FAILED",
    "UPSTREAM_NETWORK_FAILED",
    "UPSTREAM_HTTP_404",
    "UPSTREAM_HTTP_429",
    "UPSTREAM_HTTP_500",
    "UPSTREAM_HTTP_502",
    "UPSTREAM_HTTP_503",
    "UPSTREAM_HTTP_504",
    "UPSTREAM_NETWORK_FAILED",
    "UPSTREAM_DNS_FAILED",
    "STALE_ORDERBOOK",
    "INVALID_ORDERBOOK",
    "SPREAD_TOO_WIDE",
    "THIN_ORDERBOOK",
    "INDEXER_DELAYED",
    "MARKET_PAIR_MISMATCH",
    "MARKET_SOURCE_CHANGED",
    "MARKET_UNAVAILABLE",
    "MARKET_DATA_STALLED",
    "MARKET_FETCH_IN_PROGRESS",
    "NATIVE_USDC_POOL_NOT_FOUND",
    "INSUFFICIENT_CANDLES",
    "INVALID_CANDLE",
    "CANDLE_GAP",
    "PRICE_OUTLIER",
    "STALE_CANDLES",
    "UNKNOWN_PRICE_IMPACT",
    "NO_LIQUID_ROUTE_OR_UNMODELED_FEE",
  ]);
  return error instanceof Error && allowed.has(error.message)
    ? error.message
    : "DATA_OR_EXECUTION_FAILURE";
}
export const SUI = "0x2::sui::SUI";
export const USDC =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
export function coin(type: string): typeof SUI | typeof USDC {
  const normalized = normalizeStructTag(type);
  for (const allowed of [SUI, USDC] as const)
    if (normalizeStructTag(allowed) === normalized) return allowed;
  throw new Error("COIN_NOT_ALLOWED");
}
export const decimals = (type: string) => (coin(type) === SUI ? 9 : 6);
export const atomic = (amount: string | number, type: string) =>
  new Decimal(amount)
    .mul(new Decimal(10).pow(decimals(type)))
    .floor()
    .toFixed(0);
export const units = (amount: string, type: string) =>
  new Decimal(amount).div(new Decimal(10).pow(decimals(type))).toNumber();
export type Timeframe = 300 | 900 | 3600;
export interface CandleProvenance {
  origin: "ORIGINAL" | "ONE_MINUTE_AGGREGATE" | "NO_INDEXED_TRADES";
  upstream: "DeepBook Indexer";
  pair: "SUI_USDC";
  fetchedAt: number;
  timeframe: number;
  evidence: string[];
}
export interface Candle {
  provenance?: CandleProvenance;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
  timeframe: Timeframe;
}
export interface Indicators {
  ema20: number;
  ema50: number;
  rsi: number;
  macd: number;
  signal: number;
  histogram: number;
  atr: number;
  volumeChange: number;
  priceChange: number;
}
export type TradingAction = "BUY" | "SELL" | "WAIT";
export interface TradingDecision {
  action: TradingAction;
  confidence: number;
  reason: string;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  timestamp: string;
  sellPurpose?:
    | "TAKE_PROFIT"
    | "STOP_LOSS"
    | "STRATEGY_EXIT"
    | "RISK_REDUCTION"
    | "EMERGENCY_EXIT";
}
export interface MarketContext {
  candles: Candle[];
  current: Indicators;
  previous: Indicators;
  entryPrice: number | null;
  now: number;
}
export interface TradingStrategy {
  analyze(context: MarketContext): Promise<TradingDecision>;
}
export interface QuoteRequest {
  from: string;
  to: string;
  amountIn: string;
  slippage: number;
  referencePrice: number;
}
export interface QuoteResult extends QuoteRequest {
  id: string;
  amountOut: string;
  minAmountOut: string;
  priceImpact: number;
  liquid: boolean;
  createdAt: number;
  expiresAt: number;
  route: string[];
  source: string;
  dexFeeUsdc?: string | null;
}
export interface DexRouter {
  getQuote(request: QuoteRequest): Promise<QuoteResult>;
  validateQuote(quote: QuoteResult): Promise<boolean>;
}
export interface Portfolio {
  usdc: number;
  sui: number;
  costBasis: number;
  realized: number;
  fees: number;
  initialEquity: number;
  day: string;
  dayStartEquity: number;
  dailyBought: number;
  quantityAtomic?: string;
  costBasisUsdc?: string;
}
export const profitConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    minProfitUsdc: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/)
      .refine((v) => new Decimal(v).lte(5)),
    minProfitPct: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/)
      .refine((v) => new Decimal(v).lte(1)),
    targetProfitPct: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/)
      .refine((v) => new Decimal(v).gt(0) && new Decimal(v).lte(1)),
  })
  .strict();
export const profitDefaults = {
  enabled: true,
  minProfitUsdc: "0.05",
  minProfitPct: "0.01",
  targetProfitPct: "0.04",
};
export type ProfitConfig = z.infer<typeof profitConfigSchema>;
export interface Runtime {
  running: boolean;
  emergency: boolean;
  error: string | null;
  lastCandle: number | null;
}
export const settingsSchema = z
  .object({
    maxOrder: z.number().positive().max(5),
    dailyBuyLimit: z.number().positive().max(20),
    dailyLossPct: z.number().positive().max(0.01),
    maxSlippage: z.number().positive().max(0.003),
    maxHoldingRatio: z.number().positive().max(0.2),
    intervalMs: z.number().int().min(30000).max(3600000),
    strategy: z.literal("rule-based"),
    oversold: z.number().min(10).max(45),
    overbought: z.number().min(55).max(90),
    stopLossPct: z.number().positive().max(0.1),
    takeProfitPct: z.number().positive().max(0.3),
    maxVolumeChange: z.number().positive().max(20),
    feeRate: z.number().min(0).max(0.01),
    gasUsdc: z.number().positive().max(1),
    profitGuardEnabled: z.boolean().default(true),
    minNetProfitUsdc: z.number().min(0).max(5).default(0.05),
    minNetProfitPct: z.number().min(0).max(1).default(0.01),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaults: Settings = {
  maxOrder: 5,
  dailyBuyLimit: 20,
  dailyLossPct: 0.01,
  maxSlippage: 0.003,
  maxHoldingRatio: 0.2,
  intervalMs: 60000,
  strategy: "rule-based",
  oversold: 30,
  overbought: 70,
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
  maxVolumeChange: 4,
  feeRate: 0.003,
  gasUsdc: 0.03,
  profitGuardEnabled: true,
  minNetProfitUsdc: 0.05,
  minNetProfitPct: 0.01,
};
export const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10); // UTC trading day
export async function bounded<T>(fn: () => Promise<T>, ms = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("UPSTREAM_TIMEOUT")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export async function jsonFetch(url: string) {
  const r = await apiFetch(
    "GeckoTerminal",
    url,
    {
      headers: { accept: "application/json" },
    },
    url.includes("/ohlcv/") ? 20000 : 300000,
  );
  if (!r.ok) throw new Error("UPSTREAM_HTTP_" + r.status);
  return r.json() as Promise<unknown>;
}

export const profitConfigOf = (s: Settings): ProfitConfig => ({
  enabled: s.profitGuardEnabled,
  minProfitUsdc: String(s.minNetProfitUsdc),
  minProfitPct: String(s.minNetProfitPct),
  targetProfitPct: String(s.takeProfitPct),
});
