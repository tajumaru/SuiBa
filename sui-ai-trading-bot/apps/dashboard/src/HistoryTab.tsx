import type { BotEngine } from "../../worker/src/engine.ts";
import type { Candle } from "../../../packages/shared/src/index.ts";
import { OrderHistory } from "./OrderHistory.tsx";
import { FillAnalysisCard } from "./FillAnalysisCard.tsx";

/** The history tab as one lazily loaded unit: the order table
 * and the per-condition fill analysis below it. */
export function HistoryTab({
  orders,
  trades,
  candles,
}: {
  orders: Record<string, unknown>[];
  trades: ReturnType<BotEngine["snapshot"]>["trades"];
  candles: Candle[];
}) {
  return (
    <section>
      <h3>注文 / 拒否理由</h3>
      <OrderHistory orders={orders} />
      <FillAnalysisCard trades={trades} candles={candles} />
    </section>
  );
}
