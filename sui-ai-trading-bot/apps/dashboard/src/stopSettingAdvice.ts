import type { BotEngine } from "../../worker/src/engine.ts";
import { number } from "./presentation.ts";

type State = ReturnType<BotEngine["snapshot"]>;

export function stopSettingAdvice(data: State, now = Date.now()) {
  if (data.runtime.emergency) return null;
  if (data.runtime.error === "THIN_ORDERBOOK") {
    const diagnostics = data.marketData?.diagnostics;
    const book = diagnostics?.bookObservation;
    const depths = [diagnostics?.bidDepthUsdc, diagnostics?.askDepthUsdc];
    const fresh =
      book &&
      now >= book.timestamp &&
      now - book.timestamp <= 10_000 &&
      now >= book.fetchedAt &&
      now - book.fetchedAt <= 10_000 &&
      book.maxSpread === data.settings.maxSlippage &&
      depths.every(
        (d) => typeof d === "number" && Number.isFinite(d) && d >= 0,
      );
    const available = fresh ? Math.min(depths[0]!, depths[1]!) : null;
    return {
      title: "注文額を見直してください",
      message: `注文額${number(data.settings.maxOrder)} USDCに対して、取引できる量が足りません。`,
      observation:
        available !== null
          ? `直近の取引可能額：約${number(available)} USDC（買い・売りの少ない側）。`
          : null,
      action: "「1回の最大取引額」を小さくして保存してください。",
      constraints:
        "金額を減らしても、最低注文量や手数料の条件を満たさない場合は取引できません。",
      alternative:
        "取引できなければ、別のペアに切り替えるか、しばらく待ってください。",
      field: "maxOrder" as const,
    };
  }
  if (data.runtime.error === "SPREAD_TOO_WIDE")
    return {
      title: "価格の差が大きいため停止中",
      message: `売り値と買い値の差が、上限${number(data.settings.maxSlippage * 100)}%を超えています。`,
      observation: null,
      action:
        "注文額を減らしても解決しません。別のペアに切り替えるか、しばらく待ってください。",
      constraints: null,
      alternative: null,
      field: null,
    };
  return null;
}
