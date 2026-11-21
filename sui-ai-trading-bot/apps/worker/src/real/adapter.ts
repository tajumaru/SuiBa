import { Decimal } from "../../../../packages/shared/src/index.ts";
import type {
  ExecutionAdapter,
  ExecutionIntent,
  ExecutionResult,
} from "../execution-adapter.ts";
import { RealTradeCapExecutor } from "./execution.ts";
import type { RealTradeCapConfig } from "../../../../packages/shared/src/index.ts";
import type { RealBookParamsCache } from "./book-params-cache.ts";
import { RealFeeCache } from "./fee-cache.ts";

const SUI_ATOMIC = new Decimal(1_000_000_000);

/** Maps an already-approved engine intent to DeepBook. It does not make a new
 * strategy or risk decision; RealTradeCapExecutor remains the final latch and
 * generation fence immediately before every signature/send. */
export class RealTradeCapExecutionAdapter implements ExecutionAdapter {
  readonly kind = "REAL_TRADECAP" as const;
  private currentEpoch: number | null = null;

  constructor(
    private readonly executor: RealTradeCapExecutor,
    private readonly config: Pick<RealTradeCapConfig, "maxOrderDbusdc"> = {
      maxOrderDbusdc: Infinity,
    },
    private readonly fees?: RealFeeCache,
    private readonly bookParams?: RealBookParamsCache,
  ) {}

  feeEstimate(side: "BUY" | "SELL", currentEpoch: number | null) {
    if (!this.fees) throw Error("REAL_FEE_CACHE_REQUIRED");
    this.currentEpoch = currentEpoch;
    return this.fees.estimate(side, currentEpoch);
  }

  acceptStop() {
    this.executor.acceptStop();
  }

  recordEngineChecks(
    record: Parameters<RealTradeCapExecutor["recordEngineChecks"]>[0],
  ) {
    this.executor.recordEngineChecks(record);
  }

  async execute(intent: ExecutionIntent): Promise<ExecutionResult> {
    const params = await this.bookParams?.get(this.currentEpoch);
    if (!params)
      return { status: "REJECTED", errorCode: "REAL_BOOK_PARAMS_UNAVAILABLE" };

    const quotedQuantityAtomic =
      intent.side === "BUY" ? intent.quote.minAmountOut : intent.quote.amountIn;
    const quantityAtomic = new Decimal(quotedQuantityAtomic)
      .dividedToIntegerBy(params.lotSize)
      .mul(params.lotSize);
    if (quantityAtomic.lte(0) || quantityAtomic.lt(params.minSize))
      return { status: "REJECTED", errorCode: "REAL_QUANTITY_BELOW_MINIMUM" };

    const priceTicks = new Decimal(intent.markPrice)
      .mul(SUI_ATOMIC)
      .div(params.tickSize);
    const price = (
      intent.side === "BUY" ? priceTicks.floor() : priceTicks.ceil()
    )
      .mul(params.tickSize)
      .div(SUI_ATOMIC);
    const quantity = quantityAtomic.div(SUI_ATOMIC);
    if (quantity.mul(price).greaterThan(this.config.maxOrderDbusdc))
      return { status: "REJECTED", errorCode: "REAL_MAX_ORDER_EXCEEDED" };
    const result = await this.executor.execute({
      internalOrderId: intent.orderId,
      clientOrderId: String(
        intent.candleTimestamp * 10 + (intent.side === "BUY" ? 1 : 2),
      ),
      side: intent.side,
      intent: {
        price: price.toNumber(),
        quantity: quantity.toNumber(),
        expiresAt: intent.quote.expiresAt,
      },
    });
    if (result.status === "SUCCEEDED")
      return { status: "SUBMITTED", digest: result.digest! };
    if (result.status === "UNKNOWN")
      return {
        status: "UNKNOWN",
        digest: result.digest!,
        errorCode: result.errorCode!,
      };
    return {
      status: "REJECTED",
      errorCode: result.errorCode ?? "REAL_EXECUTION_REJECTED",
    };
  }
}
