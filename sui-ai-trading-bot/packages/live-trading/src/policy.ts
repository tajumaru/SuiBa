import { createHash } from "node:crypto";
import {
  fromBase58,
  isValidSuiAddress,
  isValidSuiObjectId,
  isValidTransactionDigest,
  normalizeSuiAddress,
  normalizeStructTag,
} from "@mysten/sui/utils";
import {
  coin,
  Decimal,
  SUI,
  USDC,
  defaults,
  dayKey,
} from "../../shared/src/index.ts";
import { assessRisk } from "../../risk-engine/src/index.ts";
import type {
  LivePolicy,
  WalletSnapshot,
  LiveRequest,
  LiveRoute,
  OwnedCoin,
} from "./types.ts";
export class LiveError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LiveError";
  }
}
export function requireLive(
  condition: unknown,
  code: string,
): asserts condition {
  if (!condition) throw new LiveError(code);
}
export const address = (s: string) => {
  requireLive(
    typeof s === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(s),
    "INVALID_ADDRESS",
  );
  const normalized = normalizeSuiAddress(s);
  requireLive(isValidSuiAddress(normalized), "INVALID_ADDRESS");
  return normalized;
};
export const uint = (s: string) => {
  requireLive(typeof s === "string" && /^\d+$/.test(s), "INVALID_ATOMIC");
  const n = BigInt(s);
  requireLive(n >= 0n && n <= 18446744073709551615n, "INVALID_ATOMIC");
  return n;
};
export const hashBytes = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function mainnet(chain: string) {
  try {
    const bytes = fromBase58(chain);
    return (
      bytes.length === 32 &&
      Buffer.from(bytes.subarray(0, 4)).toString("hex") === "35834a8a"
    );
  } catch {
    return false;
  }
}
export function validatePolicy(p: LivePolicy) {
  address(p.allowedWallet);
  requireLive(
    [p.aggregatorPackage, p.cetusPackage].every(
      (x) => isValidSuiObjectId(x) && address(x) !== address("0x0"),
    ),
    "INVALID_PACKAGE_POLICY",
  );
  requireLive(
    address(p.globalConfig.objectId) ===
      "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f",
    "INVALID_CETUS_CONFIG",
  );
  requireLive(
    uint(p.gasBudgetMist) > 0n &&
      uint(p.gasBudgetMist) <= 100000000n &&
      uint(p.minGasReserveMist) >= 100000000n,
    "INVALID_GAS_POLICY",
  );
  const objects = [p.globalConfig, p.partner, p.clock, p.pool];
  requireLive(
    new Set(objects.map((x) => address(x.objectId))).size === 4,
    "DUPLICATE_OBJECT_POLICY",
  );
  requireLive(
    address(p.clock.objectId) === address("0x6") &&
      !p.clock.mutable &&
      p.pool.mutable,
    "INVALID_OBJECT_POLICY",
  );
  for (const obj of objects) {
    address(obj.objectId);
    requireLive(uint(obj.initialSharedVersion) > 0n, "INVALID_OBJECT_VERSION");
    requireLive(
      typeof obj.type === "string" && obj.type.length > 0,
      "INVALID_OBJECT_TYPE",
    );
  }
}
export function validateWallet(w: WalletSnapshot, p: LivePolicy, now: number) {
  validatePolicy(p);
  requireLive(mainnet(w.chainIdentifier), "NETWORK_MISMATCH");
  requireLive(
    address(w.address) === address(p.allowedWallet),
    "WALLET_CHANGED",
  );
  requireLive(
    Number.isFinite(now) &&
      Number.isFinite(w.observedAt) &&
      now >= w.observedAt &&
      now - w.observedAt <= 15000,
    "STALE_WALLET",
  );
  uint(w.sui);
  uint(w.usdc);
  requireLive(uint(w.gasPrice) > 0n, "INVALID_GAS_PRICE");
  const ids = new Set<string>();
  for (const c of w.coins) {
    const id = address(c.objectId);
    requireLive(!ids.has(id), "DUPLICATE_COIN");
    ids.add(id);
    coin(c.coinType);
    requireLive(
      uint(c.version) > 0n && isValidTransactionDigest(c.digest),
      "INVALID_COIN_REF",
    );
    uint(c.balance);
  }
  for (const type of [SUI, USDC]) {
    const total = w.coins
      .filter((c) => coin(c.coinType) === type)
      .reduce((n, c) => n + uint(c.balance), 0n);
    requireLive(
      total <= uint(type === SUI ? w.sui : w.usdc),
      "INCONSISTENT_COIN_BALANCE",
    );
  }
  for (const expected of [p.globalConfig, p.partner, p.clock, p.pool]) {
    const actual = w.objects.filter(
      (x) => address(x.objectId) === address(expected.objectId),
    );
    requireLive(
      actual.length === 1 &&
        actual[0].initialSharedVersion === expected.initialSharedVersion &&
        actual[0].mutable === expected.mutable &&
        normalizeStructTag(actual[0].type) ===
          normalizeStructTag(expected.type),
      "OBJECT_POLICY_MISMATCH",
    );
  }
}
export function selectGas(
  w: WalletSnapshot,
  p: LivePolicy,
  inputMist = 0n,
): OwnedCoin {
  const needed = uint(p.gasBudgetMist) + uint(p.minGasReserveMist) + inputMist;
  const gas = w.coins.find(
    (c) => coin(c.coinType) === SUI && uint(c.balance) >= needed,
  );
  requireLive(gas && uint(w.sui) >= needed, "INSUFFICIENT_GAS");
  return gas;
}
export function validateIntent(
  r: LiveRequest,
  w: WalletSnapshot,
  p: LivePolicy,
  now: number,
) {
  validateWallet(w, p, now);
  const q = r.quote;
  requireLive(
    r.orderId.length > 0 && r.orderId.length <= 200,
    "INVALID_ORDER_ID",
  );
  requireLive(coin(q.from) !== coin(q.to), "COIN_DIRECTION");
  requireLive(q.liquid && q.route.length > 0, "NO_LIQUIDITY");
  requireLive(
    uint(q.amountIn) > 0n &&
      uint(q.amountOut) > 0n &&
      uint(q.minAmountOut) > 0n &&
      uint(q.minAmountOut) <= uint(q.amountOut),
    "INVALID_QUOTE",
  );
  requireLive(
    Number.isFinite(q.referencePrice) && q.referencePrice > 0,
    "INVALID_PRICE",
  );
  requireLive(
    Number.isFinite(q.slippage) && q.slippage >= 0 && q.slippage <= 0.003,
    "SLIPPAGE_LIMIT",
  );
  const minimum = new Decimal(q.amountOut)
    .mul(new Decimal(1).minus(q.slippage))
    .floor();
  requireLive(new Decimal(q.minAmountOut).equals(minimum), "MINIMUM_MISMATCH");
  const notional = new Decimal(q.amountIn)
    .div(coin(q.from) === SUI ? 1e9 : 1e6)
    .mul(coin(q.from) === SUI ? q.referencePrice : 1);
  requireLive(
    notional.lte(5) && r.risk.price === q.referencePrice,
    "LIVE_ORDER_VALUE",
  );
  const expected =
    coin(q.from) === SUI
      ? new Decimal(q.amountIn).div(1e9).mul(q.referencePrice)
      : new Decimal(q.amountIn).div(1e6).div(q.referencePrice);
  const actual = new Decimal(q.amountOut).div(coin(q.to) === SUI ? 1e9 : 1e6);
  requireLive(
    actual.div(expected).minus(1).abs().lte(0.003),
    "LIVE_PRICE_DEVIATION",
  );
  const s = r.risk.settings;
  requireLive(
    s.maxOrder <= 5 &&
      s.dailyBuyLimit <= 20 &&
      s.maxSlippage <= 0.003 &&
      s.maxHoldingRatio <= 0.2 &&
      s.dailyLossPct <= 0.01,
    "LIVE_HARD_LIMIT",
  );
  requireLive(r.risk.portfolio.day === dayKey(now), "STALE_DAILY_LEDGER");
  // The persisted live cost basis and day counters are supplied by LiveStore's caller; balances always come from the chain.
  const portfolio = {
    ...r.risk.portfolio,
    sui: new Decimal(w.sui).div(1e9).toNumber(),
    usdc: new Decimal(w.usdc).div(1e6).toNumber(),
  };
  const reasons = assessRisk({ ...r.risk, quote: q, now, portfolio });
  requireLive(reasons.length === 0, "RISK_REJECTED");
  selectGas(w, p, coin(q.from) === SUI ? uint(q.amountIn) : 0n);
}
export function validateRoute(route: LiveRoute, p: LivePolicy) {
  const { quote: q, router: r } = route;
  requireLive(
    r &&
      !r.error &&
      !r.insufficientLiquidity &&
      r.byAmountIn &&
      r.paths.length === 1,
    "UNSUPPORTED_ROUTE",
  );
  const path = r.paths[0];
  requireLive(
    path.provider === "CETUS" &&
      address(path.id) === address(p.pool.objectId) &&
      address(path.publishedAt ?? "") === address(p.cetusPackage),
    "ROUTE_NOT_ALLOWED",
  );
  requireLive(
    coin(path.from) === coin(q.from) &&
      coin(path.target) === coin(q.to) &&
      path.amountIn === q.amountIn &&
      path.amountOut === q.amountOut &&
      typeof path.direction === "boolean",
    "ROUTE_MISMATCH",
  );
  requireLive(
    r.amountIn.toString() === q.amountIn &&
      r.amountOut.toString() === q.amountOut &&
      typeof r.quoteID === "string" &&
      r.quoteID.length > 0 &&
      r.quoteID.length <= 200,
    "ROUTE_MISMATCH",
  );
  requireLive(
    Number.isFinite(r.deviationRatio) &&
      Math.abs(r.deviationRatio) <= 0.003 &&
      !(r.totalDeepFee ?? 0) &&
      !(r.overlayFee ?? 0),
    "ROUTE_FEES_OR_IMPACT",
  );
  requireLive(
    r.packages instanceof Map &&
      r.packages.size === 1 &&
      address(r.packages.get("aggregator_v3") ?? "") ===
        address(p.aggregatorPackage),
    "PACKAGE_NOT_ALLOWED",
  );
  const a = coin(path.direction ? path.from : path.target),
    b = coin(path.direction ? path.target : path.from);
  const poolType = normalizeStructTag(p.pool.type);
  requireLive(
    poolType.endsWith(`<${normalizeStructTag(a)},${normalizeStructTag(b)}>`),
    "POOL_TYPE_MISMATCH",
  );
}
export const liveHardLimits = Object.freeze({ ...defaults });
