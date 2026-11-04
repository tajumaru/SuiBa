import { dateTime, number, label } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
import { firstFilledBuy } from "./firstFill.ts";

/** The order/rejection table of the history tab, extracted
 * from the app shell so the tab can load lazily. */
export function OrderHistory({
  orders,
}: {
  orders: Record<string, unknown>[];
}) {
  if (!orders.length) return <p>注文はまだありません。</p>;
  const first = firstFilledBuy(orders);
  return (
    <div className="scroll history-scroll">
      <table className="history-table" role="table" aria-label="注文履歴">
        <thead>
          <tr>
            <th>日時（日本時間）</th>
            <th>方向</th>
            <th>状態</th>
            <th>理由</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {orders.map((o, i) => (
            <tr
              key={i}
              role="row"
              className={first?.index === i ? "first-fill" : undefined}
            >
              <td role="cell" data-label="日時" className="history-wide">
                {dateTime(o.timestamp as number)}
                {first?.index === i &&
                  (first.amountIn !== null ||
                    first.referencePrice !== null) && (
                    <span className="first-fill-meta">
                      {[
                        first.amountIn !== null
                          ? `${number(first.amountIn)} USDC`
                          : null,
                        first.referencePrice !== null
                          ? `見積もり価格 ${number(first.referencePrice, 4)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join("・")}
                    </span>
                  )}
              </td>
              <td role="cell" data-label="方向">
                {label(o.side)}
                {first?.index === i && (
                  <span className="first-fill-tag">初約定</span>
                )}
              </td>
              <td role="cell" data-label="状態">
                {label(o.status)}
              </td>
              <td role="cell" data-label="理由" className="history-wide">
                {Array.isArray(o.reasons)
                  ? o.reasons.map((r, j) => (
                      <p key={j}>
                        <Reason code={String(r)} />
                      </p>
                    ))
                  : "—"}
                <details>
                  <summary>注文の技術情報</summary>
                  <pre>{JSON.stringify(o, null, 2)}</pre>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
