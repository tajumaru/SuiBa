import React from "react";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import { dateTime, number, percent } from "./presentation.ts";
import { operationReason } from "./operationLabels.ts";

type State = BotSnapshot;
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
  INVALID_PROFIT_CONFIG: "ProfitGuardの設定値が不正です",
  MINIMUM_NET_PROFIT_MET: "最低純利益額・利益率を満たしています",
  MINIMUM_NET_PROFIT_NOT_MET: operationReason("MINIMUM_NET_PROFIT_NOT_MET"),
  PROTECTIVE_EXIT_PROFIT_BYPASS:
    "損切り・リスク削減のため利益条件は適用しません",
  PROTECTIVE_EXIT_PROFIT_DATA_UNAVAILABLE:
    "リスク削減のための売却は利益条件の対象外です。見積もり・リスク制限の確認は別途必要です",
  PROFIT_DATA_UNKNOWN: "ガス代・見積もり・原価などが不明です",
  PROJECTED_NET_EXCEEDS_ROUND_TRIP_COST:
    "想定利確時の純利益が往復コストを上回ります",
  PROJECTED_NET_INSUFFICIENT: operationReason("PROJECTED_NET_INSUFFICIENT"),
};

/**
 * One-line profit-guard summary for the dashboard tab: whether the
 * guard is enabled and, when a verdict exists, its latest reason.
 * The full detail lives on the strategy tab (ProfitGuardPanel).
 */
export function ProfitGuardSummary({ data }: { data: State }) {
  const r = data.profitGuard;
  return (
    <section aria-label="ProfitGuardの要約">
      <p className="panel-meta">
        ProfitGuard：{data.settings.profitGuardEnabled ? "有効" : "無効"}
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
    stale = r?.validUntil != null && Date.now() >= r.validUntil,
    holdingCost =
      data.acquisitionCostUsdc ?? String(data.portfolio.costBasis),
    // Fields render only when they carry a value: with no position and
    // no quote, the old grid was a wall of 不明 / — / 0.000000 that hid
    // the one informative line (the verdict). Zero or unknown values
    // stay hidden; the verdict line always renders.
    showHoldingCost = Number(holdingCost) > 0,
    avgUnit =
      data.portfolio.sui > 0
        ? data.portfolio.costBasis / data.portfolio.sui
        : null;
  return (
    <section>
      <h3>ProfitGuard · コスト控除後の利益</h3>
      {r ? (
        <>
          {(showHoldingCost ||
            avgUnit != null ||
            r.quantityAtomic ||
            r.allocatedCostUsdc != null ||
            r.breakEvenPrice ||
            r.costs?.additionalFeeUsdc != null ||
            r.costs?.gasUsdc != null ||
            r.costs?.dexFeeUsdc != null) && (
            <div className="cards">
              {showHoldingCost && (
                <div>
                  <small>現在の保有分の取得原価</small>
                  <p className="panel-meta">{precise(holdingCost)}</p>
                </div>
              )}
              {avgUnit != null && (
                <div>
                  <small>平均取得単価 / 現在価格</small>
                  <p className="panel-meta">
                    {money(avgUnit)} / {money(data.price)} USDC
                  </p>
                </div>
              )}
              {r.quantityAtomic && (
                <div>
                  <small>見積もり対象数量</small>
                  <p className="panel-meta">
                    {number(Number(r.quantityAtomic) / 1e9, 9)} 基軸通貨
                  </p>
                </div>
              )}
              {r.allocatedCostUsdc != null && (
                <div>
                  <small>対象分の取得原価（按分）</small>
                  <p className="panel-meta">{precise(r.allocatedCostUsdc)}</p>
                </div>
              )}
              {r.breakEvenPrice && (
                <div>
                  <small>モデル損益分岐価格</small>
                  <p className="panel-meta">
                    {number(r.breakEvenPrice)} USDC / 基軸通貨
                  </p>
                </div>
              )}
              {r.costs?.additionalFeeUsdc != null && (
                <div>
                  <small>売却追加手数料</small>
                  <p className="panel-meta">
                    {precise(r.costs.additionalFeeUsdc)}
                  </p>
                </div>
              )}
              {r.costs?.gasUsdc != null && (
                <div>
                  <small>売却ガス相当額</small>
                  <p className="panel-meta">{precise(r.costs.gasUsdc)}</p>
                </div>
              )}
              {r.costs?.dexFeeUsdc != null && (
                <div>
                  <small>DEX手数料（見積もりに含む）</small>
                  <p className="panel-meta">{precise(r.costs.dexFeeUsdc)}</p>
                </div>
              )}
            </div>
          )}
          {r.netProfitUsdc != null && (
            <p className="panel-meta">
              {r.scope === "BUY_SCENARIO"
                ? "購入前の想定利確時純利益"
                : "最新売却見積もりの予想純利益"}
              ：<strong>{precise(r.netProfitUsdc)}</strong>
              {r.netProfitPct != null && (
                <>（利益率：{percent(r.netProfitPct)}）</>
              )}
            </p>
          )}
          <p className="panel-meta">
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
          {r.scope === "BUY_SCENARIO" && r.purchaseInputUsdc != null && (
            <p className="panel-meta">
              購入試算：{number(r.purchaseInputUsdc)} USDC（費用込み単価{" "}
              {number(r.acquisitionUnitPrice, 4)}）
            </p>
          )}
          {r.scope === "BUY_SCENARIO" &&
            (r.roundTripCostUsdc != null || r.targetPrice != null) && (
              <p className="panel-meta">
                {r.roundTripCostUsdc != null && (
                  <>往復コスト：{number(r.roundTripCostUsdc, 4)} USDC</>
                )}
                {r.roundTripCostUsdc != null && r.targetPrice != null && (
                  <> ／ </>
                )}
                {r.targetPrice != null && (
                  <>
                    利確価格：{number(r.targetPrice, 4)}（+
                    {percent(r.targetProfitPct)}まで）
                  </>
                )}
              </p>
            )}
          <small>
            見積もり：{dateTime(r.asOf)} ·{" "}
            {stale ? "期限切れ" : "取得時点の推定"}
            {r.costs?.source === "PAPER_MODEL" &&
              " · 手数料・ガスはPAPERモデル値"}
          </small>
        </>
      ) : (
        <p className="panel-meta">
          利益判定データはまだありません。原価や見積もりを取得できない利益目的の注文は拒否します。
        </p>
      )}
      {acquisition && (
        <details>
          <summary>直近の買いの記録（PAPER仮想約定）</summary>
          <p className="panel-meta">
            数量：{number(Number(acquisition.quantityAtomic) / 1e9, 9)} 基軸通貨
            ／ 支払USDC：
            {precise(acquisition.inputUsdc)} ／ 総取得原価：
            {precise(acquisition.totalCostUsdc)}
          </p>
          <p className="panel-meta">
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
