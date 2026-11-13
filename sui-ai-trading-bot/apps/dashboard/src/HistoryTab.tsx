import { StopHistory } from "./StopHistory.tsx";
import type { OperationsSnapshot } from "./operationsTypes.ts";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import type { Candle } from "../../../packages/shared/src/index.ts";
import { OrderHistory } from "./OrderHistory.tsx";
import { FillAnalysisCard } from "./FillAnalysisCard.tsx";

/** The history tab as one lazily loaded unit: the order table
 * and the per-condition fill analysis below it. */
export function HistoryTab({
  operations,
  operationsError,
  orders,
  trades,
  candles,
}: {
  operations?: OperationsSnapshot | null;
  operationsError?: string;
  orders: Record<string, unknown>[];
  trades: BotSnapshot["trades"];
  candles: Candle[];
}) {
  return (
    <section>
      <StopHistory data={operations ?? null} error={operationsError} />
      <h3>注文 / 拒否理由</h3>
      <OrderHistory orders={orders} />
      <FillAnalysisCard trades={trades} candles={candles} />
    </section>
  );
}
