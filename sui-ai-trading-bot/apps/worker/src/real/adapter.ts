import { Decimal } from "../../../../packages/shared/src/index.ts";
import type {
  ExecutionAdapter,
  ExecutionIntent,
  ExecutionResult,
} from "../execution-adapter.ts";
import { RealTradeCapExecutor } from "./execution.ts";
import type { RealTradeCapConfig } from "../../../../packages/shared/src/index.ts";

const SUI_ATOMIC = new Decimal(1_000_000_000);

/** Maps an already-approved engine intent to DeepBook. It does not make a new
 * strategy or risk decision; RealTradeCapExecutor remains the final latch and
 * generation fence immediately before every signature/send. */
export class RealTradeCapExecutionAdapter implements ExecutionAdapter {
  readonly kind = "REAL_TRADECAP" as const;
  constructor(
    private readonly executor: RealTradeCapExecutor,
    private readonly config: Pick<RealTradeCapConfig, "maxOrderDbusdc"> = {
      maxOrderDbusdc: Infinity,
    },
  ) {}

  acceptStop() {
    this.executor.acceptStop();
  }

  async execute(intent: ExecutionIntent): Promise<ExecutionResult> {
    const quantityAtomic =
      intent.side === "BUY" ? intent.quote.minAmountOut : intent.quote.amountIn;
    const quantity = new Decimal(quantityAtomic).div(SUI_ATOMIC).toNumber();
    if (
      new Decimal(quantity)
        .mul(intent.markPrice)
        .greaterThan(this.config.maxOrderDbusdc)
    )
      return { status: "REJECTED", errorCode: "REAL_MAX_ORDER_EXCEEDED" };
    const result = await this.executor.execute({
      internalOrderId: intent.orderId,
      clientOrderId: String(
        intent.candleTimestamp * 10 + (intent.side === "BUY" ? 1 : 2),
      ),
      side: intent.side,
      intent: {
        price: intent.markPrice,
        quantity,
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
