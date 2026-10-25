import React from "react";
import type { BotEngine } from "../../worker/src/engine.ts";
import { dateTime, number, percent } from "./presentation.ts";

type State = ReturnType<BotEngine["snapshot"]>;
const money = (v: number | null | undefined) => number(v, 4);
const precise = (v: string | null | undefined) =>
  v == null ? "不明" : `${number(v)} USDC`;

/** Japanese text for each profit-guard verdict reason code. */
const profitGuardReasonText: Record<string, string> = {
  PROFIT_GUARD_DISABLED:
    "最低利益条件は無効です。費用・見積もり検証とリスク制限は継続します",
  QUOTE_UNAVAILABLE: "最新の有効な見積もりを取得できません",
  QUOTE_EXPIRED: "見積もりの有効期限が切れています",
  INVALID_QUOTE: "見積もりの方向・数量・最低受取額などが不正です",
  UNKNOWN_COSTS: "ガス代または追加手数料が不明・不正です",
  INVALID_POSITION: "保有数量または取得原価が不正です",
  INSUFFICIENT_POSITION: "売却数量が保有数量を超えています",
  INVALID_PROFIT_CONFIG: "利益保護の設定値が不正です",
  MINIMUM_NET_PROFIT_MET: "最低純利益額・利益率を満たしています",
  MINIMUM_NET_PROFIT_NOT_MET: "手数料控除後の利益が最低条件に届きません",
  PROTECTIVE_EXIT_PROFIT_BYPASS: "損切り・リスク削減のため利益条件は適用しません",
  PROTECTIVE_EXIT_PROFIT_DATA_UNAVAILABLE:
    "リスク削減のための売却は利益条件の対象外です。見積もり・リスク制限の確認は別途必要です",
  PROFIT_DATA_UNKNOWN: "ガス代・見積もり・原価などが不明です",
  PROJECTED_NET_EXCEEDS_ROUND_TRIP_COST:
    "想定利確時の純利益が往復コストを上回ります",
  PROJECTED_NET_INSUFFICIENT:
    "想定利確時の純利益が往復コストまたは最低条件に届きません",
};

/**
 * One-line profit-guard summary for the dashboard tab: whether the
 * guard is enabled and, when a verdict exists, its latest reason.
 * The full detail lives on the strategy tab (ProfitGuardPanel).
 */
export function ProfitGuardSummary({ data }: { data: State }) {
  const r = data.profitGuard;
  return (
    <section aria-label="利益保護の要約">
      <p>
        利益保護：{data.settings.profitGuardEnabled ? "有効" : "無効"}
        {r
          ? ` · 直近の判定：${profitGuardReasonText[r.reason] ?? "利益判定の安全性を確認できません"}`
          : " · 判定データはまだありません"}
        。詳細は戦略タブで確認できます。
      </p>
    </section>
  );
}

/**
 * The full profit-guard detail panel (cost breakdown after fees and
 * gas). Rendered inside a disclosure on the strategy tab so the
 * strategy view can lead with a compact status card without dropping
 * any of this detail. The dashboard tab shows ProfitGuardSummary
 * instead.
 */
export function ProfitGuardPanel({ data }: { data: State }) {
  const r = data.profitGuard,
    acquisition = data.acquisitionFees,
    stale = r?.validUntil != null && Date.now() >= r.validUntil;
  return (
    <section>
      <h3>利益保護 · コスト控除後の利益</h3>
      <div className="cards">
        <div>
          <small>現在の保有分の取得原価</small>
          <p>
            {precise(
              data.acquisitionCostUsdc ?? String(data.portfolio.costBasis),
            )}
          </p>
        </div>
        <div>
          <small>平均取得単価 / 現在価格</small>
          <p>
            {money(
              data.portfolio.sui > 0
                ? data.portfolio.costBasis / data.portfolio.sui
                : null,
            )}{" "}
            / {money(data.price)} USDC
          </p>
          <small>見積もり対象数量</small>
          <p>
            {r?.quantityAtomic
              ? `${number(Number(r.quantityAtomic) / 1e9, 9)} SUI`
              : "—"}
          </p>
        </div>
        <div>
          <small>対象分の取得原価（按分）</small>
          <p>{precise(r?.allocatedCostUsdc)}</p>
        </div>
        <div>
          <small>モデル損益分岐価格</small>
          <p>
            {r?.breakEvenPrice
              ? `${number(r.breakEvenPrice)} USDC / SUI`
              : "不明"}
          </p>
        </div>
      </div>
      {r ? (
        <>
          <p>
            {r.scope === "BUY_SCENARIO"
              ? "購入前の想定利確時純利益"
              : "最新売却見積もりの予想純利益"}
            ：<strong>{precise(r.netProfitUsdc)}</strong>
          </p>
          <p>
            利益率：
            {r.netProfitPct == null ? "不明" : percent(r.netProfitPct)} ／
            判定：
            {r.reason.startsWith("PROTECTIVE_EXIT")
              ? "損切り・リスク削減優先"
              : r.reason === "QUOTE_UNAVAILABLE"
                ? "見積もり取得失敗"
                : r.netProfitUsdc === null
                  ? "計算不能"
                  : r.allowed
                    ? "利確可能（試算）"
                    : "利益不足・見送り"}{" "}
            ·{" "}
            {profitGuardReasonText[r.reason] ??
              "利益判定の安全性を確認できません"}
            <small>コード：{r.reason}</small>
          </p>
          <p>
            <small>
              利益条件の通過は、ボットの開始・リスク制限の許可・実約定を意味しません。
            </small>
          </p>
          <div className="cards">
            <div>
              <small>売却追加手数料</small>
              <p>{precise(r.costs?.additionalFeeUsdc)}</p>
            </div>
            <div>
              <small>売却ガス相当額</small>
              <p>{precise(r.costs?.gasUsdc)}</p>
            </div>
            <div>
              <small>DEX手数料（見積もりに含む）</small>
              <p>
                {r.costs?.dexFeeUsdc == null
                  ? "内訳不明・二重加算なし"
                  : precise(r.costs.dexFeeUsdc)}
              </p>
            </div>
            <div>
              <small>最低利益額 / 最低利益率</small>
              <p>
                {number(r.minProfitUsdc)} USDC / {percent(r.minProfitPct)}
              </p>
            </div>
          </div>
          {r.scope === "BUY_SCENARIO" && (
            <p>
              購入予定：{precise(r.purchaseInputUsdc)} ／ 費用込み想定取得単価：
              {number(r.acquisitionUnitPrice)} USDC / SUI ／ 購入追加手数料：
              {precise(r.buyCosts?.additionalFeeUsdc)} ／ 購入ガス：
              {precise(r.buyCosts?.gasUsdc)} ／ 想定往復コスト：
              {precise(r.roundTripCostUsdc)} ／ 想定利確価格：
              {number(r.targetPrice)} USDC（想定上昇率の上限
              {percent(r.targetProfitPct)}
              、戦略の利確価格が低い場合はそちらを採用）。現在の逆方向見積もりからの推定で、将来の利益を保証しません。
            </p>
          )}
          <small>
            見積もり日時：{dateTime(r.asOf)} ·{" "}
            {stale ? "期限切れ（実行には再見積もりが必要）" : "取得時点の推定"}{" "}
            · {r.source ?? "取得元不明"} ·{" "}
            {r.costs?.source === "PAPER_MODEL"
              ? "手数料・ガスはPAPERモデル値"
              : "費用ソースを確認してください"}
          </small>
        </>
      ) : (
        <p>
          利益判定データはまだありません。原価や見積もりを取得できない利益目的の注文は拒否します。
        </p>
      )}
      {acquisition && (
        <details>
          <summary>直近の買いの記録（PAPER仮想約定）</summary>
          <p>
            数量：{number(Number(acquisition.quantityAtomic) / 1e9, 9)} SUI ／
            支払USDC：
            {precise(acquisition.inputUsdc)} ／ 総取得原価：
            {precise(acquisition.totalCostUsdc)}
          </p>
          <p>
            追加手数料：{precise(acquisition.additionalFeeUsdc)} ／ ガス：
            {precise(acquisition.gasUsdc)} ／ DEX手数料：
            {acquisition.dexFeeUsdc === null
              ? "見積もり内に含まれるが内訳不明"
              : precise(acquisition.dexFeeUsdc)}
          </p>
        </details>
      )}
    </section>
  );
}
