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
      message: `取引できる量が不足したため停止しました。「1回の最大取引額」は現在${number(data.settings.maxOrder)} USDCです。`,
      observation:
        available !== null
          ? `直近の確認では、設定した価格の範囲内で取引できる量は約${number(available)} USDC分です（買い・売りの少ない側）。`
          : null,
      action:
        "「戦略」→「設定」の「1回の最大取引額」を小さくして保存してください。金額を減らしても、最低注文量や手数料の条件を満たさない場合は取引できません。",
      alternative:
        "小さくしても取引できない場合は、市場の状況が変わるまで待つか、停止中に別の取引ペアへ切り替えてください。",
      field: "maxOrder" as const,
    };
  }
  if (data.runtime.error === "SPREAD_TOO_WIDE")
    return {
      title: "今は価格の差が大きいため取引できません",
      message: `現在の「価格ずれの上限」は${number(data.settings.maxSlippage * 100)}%です。売り値と買い値の差がこの上限を超えたため停止しました。`,
      observation: null,
      action:
        "この場合は注文額を減らしても解決しません。価格の差が小さくなるまで待つか、停止中に別の取引ペアへ切り替えてください。",
      alternative: null,
      field: null,
    };
  return null;
}
