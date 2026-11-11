import { ValidationControl } from "./ValidationControl.tsx";
import type { ControlState } from "./validationControl.ts";
import { OperationSummary, OperationGuidance } from "./OperationOverview.tsx";
import { MarketDataPanel } from "./MarketDataPanel.tsx";
import { ConnectivityPanel } from "./ConnectivityPanel.tsx";
import { operationReason } from "./operationLabels.ts";
import { DeepBookValidation } from "./DeepBookValidation.tsx";
import React, { useState } from "react";
import type { SettingsApi } from "./settingsPresets.ts";
import {
  dateTime,
  fixed4,
  number as formatNumber,
  label,
  percent,
  nextStep,
} from "./presentation.ts";
import { Reason } from "./Reason.tsx";
import {
  downloadDiagnosticReport,
  episodeSummaryText,
} from "./diagnosticExport.ts";
import type { OperationsSnapshot } from "./operationsTypes.ts";
import {
  useOperationsFeed,
  type OperationsFeed,
} from "./operationsFeed.ts";
export type { OperationsSnapshot } from "./operationsTypes.ts";
export { useOperationsFeed, type OperationsFeed } from "./operationsFeed.ts";
const date = dateTime;
const number = formatNumber;
function amount(value: string | number) {
  // Small fees can arrive in scientific notation.
  const decimal = String(value);
  if (/^-?\d+(\.\d+)?e[+-]?\d+$/i.test(decimal) && Number.isFinite(Number(value))) {
    return Number(value).toLocaleString("ja-JP", {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });
  }
  return fixed4(decimal);
}
const usdc = (v: string | number | null) =>
  v == null ? "不明" : `${amount(v)} USDC`;
function accountingValue(key: string, value: string | number | null | undefined) {
  if (value == null || ["sui", "quantity", "quantityAtomic"].includes(key))
    return number(value);
  return amount(value);
}
export function OperationsView({
  data,
  stale = false,
  api,
  state,
  refresh,
}: {
  state?: ControlState;
  refresh?: () => Promise<void>;
  data: OperationsSnapshot;
  stale?: boolean;
  api?: SettingsApi;
}) {
  const [hours, setHours] = useState<24 | 168>(24);
  const report = data.reports.find((r) => r.hours === hours);
  const latest = data.accounting.latest,
    ledger = data.accounting.ledger;
  return (
    <div className="operation-validation">
      <ValidationControl
        data={data}
        state={state}
        stale={stale}
        api={api}
        refresh={refresh}
      />
      <OperationSummary data={data} stale={stale} />
      {!!data.validation?.candles?.unresolved && (
        <p className="panel-meta warning" role="alert">
          ローソク足に未解決の品質問題があります。詳細診断で確認してください。
        </p>
      )}
      {data.stopReason && (
        <p className="panel-meta error">
          停止理由：
          <Reason code={data.stopReason} /> 次の確認：
          {nextStep(data.stopReason)}
        </p>
      )}
      {(!ledger.ok || (latest && !latest.ok)) && (
        <p className="panel-meta error" role="alert">
          残高・損益の不整合を検出しました。PAPER運用を停止し、詳細診断を確認してください。
        </p>
      )}
      <section aria-label="主要KPI">
        <div className="operation-period" role="group" aria-label="集計期間">
          {([24, 168] as const).map((h) => (
            <button
              key={h}
              aria-pressed={hours === h}
              onClick={() => setHours(h)}
            >
              {h === 24 ? "24時間" : "7日間"}
            </button>
          ))}
        </div>
        {report ? (
          <div className="operation-kpis">
            <article>
              <h3>取引（{hours === 24 ? "24時間" : "7日間"}）</h3>
              <strong>{report.tradeCount}件</strong>
              <small>
                買い {number(report.buyCount)} / 売り{" "}
                {number(report.sellCount)}
              </small>
            </article>
            <article>
              <h3>純損益（{hours === 24 ? "24時間" : "7日間"}）</h3>
              <strong>
                {report.netPnl == null
                  ? "評価データ不足"
                  : usdc(report.netPnl)}
              </strong>
              <small>
                見送り 利益保護{report.profitGuardSkipped} · リスク
                {report.riskSkipped}
              </small>
            </article>
          </div>
        ) : (
          <p className="panel-meta">選択期間のレポートを取得できません。</p>
        )}
      </section>
      <details id="operation-diagnostics" className="operation-diagnostics">
        <summary>詳細診断 · API通信・停止理由・品質・会計・監査ログ</summary>
        <p className="panel-meta">
          <button type="button" onClick={() => downloadDiagnosticReport(data)}>
            AI調査用レポートを書き出す
          </button>{" "}
          <small>
            止まった原因を AI に調べさせるためのファイル（状態・失敗の内訳・直近の記録）を保存します。
          </small>
        </p>
        {data.environment ? (
          <p className="panel-meta">
            <small>
              実行環境： {data.environment.mode} / {data.environment.pair} /
              市場 {data.environment.provider ?? "不明"}
              {data.environment.paperCheck.armed &&
              data.environment.paperCheck.expires != null
                ? ` / 検証中（期限 ${date(data.environment.paperCheck.expires)}）`
                : data.environment.paperCheck.enabled
                  ? " / paper-check 有効"
                  : ""}
              {data.environment.maintenance ? " / maintenance 中" : ""}
            </small>
          </p>
        ) : null}
        {/* Secondary KPIs and the guidance sections live in the
            diagnostics fold: the everyday layer keeps only the
            trade count and net PnL next to the hero and the
            alert banners (the report periods and coverage notes
            are on the full reports just below). */}
        <div className="operation-kpis">
          <article>
            <h3>データ正常性</h3>
            <strong>
              {stale
                ? "状態不明"
                : data.timing?.dataStatus === "FRESH" &&
                    data.timing.transportRecent
                  ? "鮮度内"
                  : data.timing?.dataStatus === "UPDATING" &&
                      data.timing.transportRecent
                    ? "確定足待ち"
                    : "要確認"}
            </strong>
            <small>現在の取得状態</small>
          </article>
          <article>
            <h3>稼働（監視開始以降）</h3>
            <strong>{Math.floor(data.runningMs / 60000)}分</strong>
            <small>確認済み稼働</small>
          </article>
        </div>
        <OperationGuidance
          data={data}
          hours={hours}
          stale={stale}
          insideDiagnostics
        />
        <section>
          <h2>24時間・7日間の検証レポート</h2>
          <div className="operation-reports">
            {data.reports
              .filter((r) => r.hours === hours)
              .map((r) => (
                <article
                  key={r.hours}
                  aria-label={
                    r.hours === 24 ? "24時間レポート" : "7日間レポート"
                  }
                >
                  <h3>{r.hours === 24 ? "24時間" : "7日間"}</h3>
                  <small>
                    {date(r.from)} 〜 {date(r.until)}
                  </small>
                  {!r.fullMonitoringCoverage && (
                    <p className="panel-meta">
                      監視記録は{date(r.observedFrom)}からの一部期間です。
                    </p>
                  )}
                  <dl className="operation-report-grid">
                    {[
                      [
                        "取引回数",
                        `${r.tradeCount}件（買い ${number(r.buyCount)} / 売り ${number(r.sellCount)}）`,
                      ],
                      [
                        "勝率（売却単位）",
                        r.winRate == null
                          ? "算出不可（売却なし）"
                          : percent(r.winRate),
                      ],
                      [
                        "純損益（保有分の評価損益を含む）",
                        r.netPnl == null
                          ? "評価データ不足"
                          : usdc(r.netPnl),
                      ],
                      [
                        "最大ドローダウン",
                        r.maxDrawdown == null
                          ? "評価データ不足"
                          : percent(r.maxDrawdown),
                      ],
                      ["利益保護による見送り", `${r.profitGuardSkipped}件`],
                      ["リスク制限による見送り", `${r.riskSkipped}件`],
                      [
                        "エラー記録 / 異常検出記録",
                        `${r.errors} / ${r.anomalies}件（同じ障害の重複を含むため合算不可）`,
                      ],
                      ["累計手数料（ガスを含む）", usdc(r.costs.feesUsdc)],
                      ["ガス代", usdc(r.costs.gasUsdc)],
                    ].map(([label, value]) => (
                      <div className="operation-report-metric" key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <small>損益の比較開始：{date(r.valuationBaselineAt)}</small>
                  <details>
                    <summary>運用停止理由（{r.stopReasons.length}件）</summary>
                    <ul>
                      {r.stopReasons.map((s, i) => (
                        <li key={i}>
                          {date(s.timestamp)}：<Reason code={s.reason} />
                        </li>
                      ))}
                    </ul>
                  </details>
                </article>
              ))}
          </div>
        </section>
        {/* The market-data connection and DeepBook validation blocks
            live only on this tab, at the head of its diagnostics
            details (off the always-visible layers and off the
            other tabs). */}
        {state?.marketData && (
          <MarketDataPanel value={state.marketData} unavailable={stale} />
        )}
        {data.validation && (
          <DeepBookValidation
            report={data.validation}
            operations={data}
            stale={stale}
          />
        )}
        <ConnectivityPanel
          safety={data.safety}
          timing={data.timing}
          stale={stale}
        />
        <section>
          <h2>運用検証</h2>
          <p className="panel-meta">
            監視開始：{date(data.observedSince)}
            。実資金の売買・署名・送信は行いません。
          </p>
          {data.stopReason && (
            <p className="panel-meta error">
              停止理由：
              <Reason code={data.stopReason} />
              次の操作：{nextStep(data.stopReason)}
            </p>
          )}
          {data.timing && (
            <div className="card" aria-label="市場データ取得タイミング">
              <p className="panel-meta">
                市場データ：
                {
                  {
                    FRESH: "鮮度内",
                    UPDATING: "確定足の更新待ち",
                    STALE: "確定足が期限切れ",
                    UNKNOWN: "未取得",
                  }[data.timing.dataStatus]
                }{" "}
                ／ 通信：
                {data.timing.transportRecent
                  ? "直近の成功あり"
                  : "直近の成功未確認"}
              </p>
              <p className="panel-meta">
                最終取得試行：{date(data.timing.lastFetchAttemptAt)} ／
                最終取得成功：{date(data.timing.lastFetchSuccessAt)} ／
                最終分析成功：{date(data.timing.lastAnalysisAt)}
              </p>
              <p className="panel-meta">
                取得中：{data.timing.fetching ? "はい" : "いいえ"} ／ 取得開始：
                {date(data.timing.fetchStartedAt)} ／ 前回所要時間：
                {number(data.timing.lastFetchDurationMs)} ms ／ 次回予定：
                {date(data.timing.nextFetchAt)}
              </p>
            </div>
          )}
          <div className="cards">
            {[
              [
                "PAPER運用時間",
                `${Math.floor(data.runningMs / 3600000)}時間 ${Math.floor(data.runningMs / 60000) % 60}分`,
              ],
              ["市場データ最終取得", date(data.lastMarketAt)],
              ["見積もり最終取得", date(data.lastQuoteAt)],
              ["最終売買", date(data.lastTradeAt)],
              [
                "買い / 売り / 見送り（最終判定の累計）",
                `${number(data.actions.buys)} / ${number(data.actions.sells)} / ${number(data.actions.waits)}`,
              ],
              ["利益保護による拒否", String(data.actions.profitRejected)],
              ["リスク制限による拒否", String(data.actions.riskRejected)],
              ["APIエラー", String(data.apiErrors)],
              ["連続エラー", String(data.consecutiveErrors)],
              ["最終正常動作", date(data.lastHealthyAt)],
            ].map(([label, value]) => (
              <div key={label}>
                <small>{label}</small>
                <p className="panel-meta">{value}</p>
              </div>
            ))}
          </div>
          <small>
            運用時間は手動開始から停止までの確認済み時間。最終アクションは監視開始後の集計です。表示用の利益試算は拒否回数に含めません。
          </small>
        </section>
        <section>
          <h3>外部API接続（このプロセスの集計）</h3>
          {data.stopReason === "UPSTREAM_HTTP_429" && (
            <p className="panel-meta error">
              APIの利用制限に達しました。安全のためPAPER取引を停止しています。再試行可能時刻を確認してください。
            </p>
          )}
          <p className="panel-meta">
            再試行待機解除後も自動再開しません。異常解除とPAPER開始を個別に操作してください。
          </p>
          {(data.apis ?? []).map((a) => (
            <article key={a.api}>
              <h4>{a.api}</h4>
              <p className="panel-meta">
                連続通信障害への保護：
                {stale
                  ? "状態不明"
                  : a.circuit === "OPEN"
                    ? "通信を一時抑制しています"
                    : a.circuit === "HALF_OPEN"
                      ? "試験通信で復旧を確認します（注文は安全確認後）"
                      : a.circuit === "CLOSED"
                        ? "通信抑制なし"
                        : "状態不明"}
                {a.circuitUntil != null && (
                  <> ／ 試験通信可能時刻：{date(a.circuitUntil)}</>
                )}
              </p>
              {a.lastFailure && (
                <div className="warning">
                  <p className="panel-meta">
                    最終通信障害：{operationReason(a.lastFailure.code)} ／{" "}
                    {a.lastFailure.elapsedMs}ms
                  </p>
                  <p className="panel-meta">
                    処理：
                    {(
                      {
                        POOL_METADATA: "プール情報",
                        POOL_DISCOVERY: "プール探索",
                        OHLCV_5M: "5分足取得",
                        OHLCV_15M: "15分足取得",
                        OHLCV_1H: "1時間足取得",
                        SUI_GRPC_READ: "Sui読み取り",
                        CETUS_HTTP_READ: "Cetus取得",
                        HTTP_READ: "外部データ取得",
                      } as Record<string, string>
                    )[a.lastFailure.operation] ?? "外部データ取得"}{" "}
                    ／ ホスト：
                    {a.lastFailure.host} ／ 段階：
                    {
                      {
                        HEADERS_OR_CONNECT:
                          "接続・応答ヘッダー待ち（詳細未確定）",
                        CONNECT: "接続",
                        DNS: "名前解決",
                        TLS: "TLS",
                        BODY: "応答本文",
                        HTTP: "HTTP応答",
                      }[a.lastFailure.phase]
                    }
                  </p>
                  <p className="panel-meta">
                    HTTP：{a.lastFailure.status ?? "応答前"} ／ 原因コード：
                    {a.lastFailure.causeCode ?? "不明"} ／ 発生：
                    {date(a.lastFailure.occurredAt)}
                  </p>
                  <p className="panel-meta" style={{ overflowWrap: "anywhere" }}>
                    URL（秘密情報を除外）：{a.lastFailure.url}
                  </p>
                </div>
              )}

              <p className="panel-meta">
                最終API応答時間：
                {a.lastLatencyMs == null
                  ? "不明"
                  : number(a.lastLatencyMs) + " ms"}{" "}
                ／ リクエスト：{a.requests}件 ／ 直近1分：{a.requestsPerMinute}
                件 ／ 429：{a.rateLimits}件 ／ 再試行：{a.retries}回
              </p>
              <p className="panel-meta">
                接続：
                {a.exhausted
                  ? "再試行上限・手動解除が必要"
                  : a.backoff
                    ? "再試行待機中"
                    : a.active
                      ? "取得中"
                      : a.failed
                        ? "通信異常"
                        : a.lastSuccessAt
                          ? "接続正常"
                          : "未確認"}{" "}
                ／ データ：
                {a.delayed
                  ? "遅延・未取得"
                  : "取得済み（売買時に鮮度を再検証）"}
              </p>
              <p className="panel-meta">
                次回再試行可能：{date(a.nextRetryAt)} ／ 最終正常取得：
                {date(a.lastSuccessAt)}
              </p>
            </article>
          ))}
        </section>
        <section>
          <h3>残高・損益の整合性</h3>
          <div className="cards">
            {Object.entries(data.accounting.current).map(([key, value]) => (
              <div key={key}>
                <small>
                  {
                    (
                      {
                        usdc: "USDC残高",
                        sui: "基軸通貨残高",
                        costBasis: "取得原価（USDC）",
                        realized: "実現損益（USDC）",
                        unrealized: "未実現損益（USDC）",
                        fees: "累計手数料・ガス（USDC）",
                        equity: "総資産評価額（USDC）",
                        price: "評価価格（USDC / 基軸通貨）",
                      } as Record<string, string>
                    )[key]
                  }
                </small>
                <p className="panel-meta">{accountingValue(key, value)}</p>
              </div>
            ))}
          </div>
          {(!ledger.ok || (latest && !latest.ok)) && (
            <p className="panel-meta error" role="alert">
              不整合を検出しました。PAPER運用を停止し、記録を確認してください。
            </p>
          )}
          <p className="panel-meta">
            {latest
              ? latest.ok && ledger.ok
                ? "直近約定の照合：一致"
                : "直近約定の照合：不一致"
              : "約定後の照合記録はまだありません。"}
          </p>
          <p className="panel-meta">
            照合済み約定：{ledger.verifiedFills}件 ／ 監視導入前の約定：
            {ledger.legacyFills}件
          </p>
          <p className="panel-meta">
            累計手数料（ガス込み）：{usdc(data.accounting.totals.feesUsdc)} ／
            累計ガス代：{usdc(data.accounting.totals.gasUsdc)}
          </p>
          {data.accounting.totals.unknownGasTrades > 0 && (
            <p className="panel-meta">
              ガス代不明の旧約定が{data.accounting.totals.unknownGasTrades}
              件あります。確認できたガス代の小計：
              {usdc(data.accounting.totals.knownGasUsdc)}。
            </p>
          )}
          <p className="panel-meta">
            ガス照合：期待値{usdc(ledger.expectedGasUsdc)} ／ 約定記録
            {usdc(ledger.actualGasUsdc)}
          </p>
          <p className="panel-meta">
            許容誤差：基軸通貨 0.000000001（9桁）、USDC
            0.000001（6桁）。資産評価額はUSDC 1最小単位＋価格×基軸通貨
            1最小単位です。
          </p>
          {ledger.reasons.map((reason) => (
            <p className="panel-meta error" key={reason}>
              <Reason code={reason} />
            </p>
          ))}
          {latest && (
            <details>
              <summary>直近約定の照合詳細 · {date(latest.timestamp)}</summary>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>項目</th>
                      <th>独立した計算結果</th>
                      <th>約定後の記録</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(latest.expected).map((key) => (
                      <tr key={key}>
                        <td>
                          {(
                            {
                              usdc: "USDC残高",
                              sui: "基軸通貨残高",
                              quantityAtomic: "基軸通貨最小単位の数量",
                              costBasis: "取得原価",
                              costBasisUsdc: "取得原価の精密値",
                              realized: "実現損益",
                              unrealized: "未実現損益",
                              fees: "累計手数料（ガスを含む）",
                              tradeFee: "今回の手数料",
                              quantity: "今回の基軸通貨数量",
                              equity: "総資産評価額",
                              pnlMovement: "損益の変化",
                              gasUsdc: "今回のガス代",
                              modeledGas: "設定から計算したガス代",
                              modeledAdditionalFee:
                                "設定から計算した追加手数料",
                              tradePrice: "今回の約定価格",
                              acquisitionCost: "今回の取得原価",
                              allocatedCost: "部分売却の取得原価",
                              tradeRealized: "今回の実現損益",
                            } as Record<string, string>
                          )[key] ?? "照合項目"}
                        </td>
                        <td>
                          {latest.expected[key] == null
                            ? "不明"
                            : accountingValue(key, latest.expected[key])}
                        </td>
                        <td>
                          {latest.actual[key] == null
                            ? "不明"
                            : accountingValue(key, latest.actual[key])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {latest.reasons.map((r) => (
                <p className="panel-meta" key={r}>
                  <Reason code={r} />
                </p>
              ))}
            </details>
          )}
        </section>
        <section>
          <h3>売買候補ごとの検証記録（直近50件）</h3>
          {data.candidates.length === 0 && (
            <p className="panel-meta">
              売買候補はまだありません。候補0件だけでは正常・異常を判断できません。
            </p>
          )}
          {data.candidates.map((c) => (
            <details className="operation-candidate" key={c.id}>
              <summary>
                {date(c.createdAt)} · {label(c.side)}候補 →{" "}
                {c.finalAction === "SAFE_STOP"
                  ? "安全停止"
                  : c.finalAction === "PENDING"
                    ? "処理中"
                    : label(c.finalAction)}
              </summary>
              <dl>
                {[
                  [
                    "売買予定数量",
                    c.quantityAtomic
                      ? `${number(Number(c.quantityAtomic) / 1e9, 9)} 基軸通貨`
                      : "見積もり未取得",
                  ],
                  [
                    "見積もり価格（最低受取額から計算）",
                    c.quotePriceUsdc
                      ? `${usdc(c.quotePriceUsdc)} / 基軸通貨`
                      : "不明",
                  ],
                  ["見積もり有効期限", date(c.quoteExpiresAt)],
                  ["取得原価", usdc(c.acquisitionCostUsdc)],
                  [
                    "予想売却額",
                    `${usdc(c.expectedSaleUsdc)}${c.saleModel === "PROJECTED_TARGET" ? "（想定利確時）" : ""}`,
                  ],
                  [
                    "DEX手数料",
                    c.dexFeeUsdc == null
                      ? "内訳不明（見積もりに含む）"
                      : usdc(c.dexFeeUsdc),
                  ],
                  ["PAPERガス代", usdc(c.gasUsdc)],
                  [
                    "想定売却時の追加手数料",
                    usdc(c.projectedSaleFeeUsdc ?? null),
                  ],
                  [
                    "想定売却時のガス代（分割回数込み）",
                    usdc(c.projectedSaleGasUsdc ?? null),
                  ],
                  ["追加手数料", usdc(c.additionalFeeUsdc)],
                  ["想定純利益", usdc(c.netProfitUsdc)],
                  [
                    "最低利益条件",
                    `${usdc(c.minProfitUsdc)} / ${percent(c.minProfitPct)}`,
                  ],
                  [
                    "利益保護判定",
                    !c.profitGuard.evaluated
                      ? "未評価"
                      : c.profitGuard.allowed
                        ? "許可"
                        : "拒否",
                  ],
                  [
                    "リスク制限判定",
                    c.risk.status === "NOT_EVALUATED"
                      ? "未評価（前段の条件未通過または処理中）"
                      : c.risk.status === "ALLOWED"
                        ? "許可"
                        : "拒否",
                  ],
                ].map(([label, value]) => (
                  <React.Fragment key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </React.Fragment>
                ))}
              </dl>
              {c.profitGuard.reason && (
                <p className="panel-meta">
                  利益保護：
                  <Reason code={c.profitGuard.reason} />
                </p>
              )}
              {c.reasons.map((reason, i) => (
                <p className="panel-meta" key={i}>
                  <Reason code={reason} />
                </p>
              ))}
            </details>
          ))}
        </section>
        <section>
          <h3>異常・停止などの記録（直近50件）</h3>
          {data.events.length === 0 ? (
            <p className="panel-meta">記録はまだありません。</p>
          ) : (
            <ul>
              {data.events.map((e, i) => (
                <li key={i}>
                  {date(e.timestamp)}：<Reason code={e.code} />
                  {e.details && (
                    <details>
                      <summary>停止判定の詳細</summary>
                      <pre>{JSON.stringify(e.details, null, 2)}</pre>
                    </details>
                  )}
                  {e.apiFailure && (
                    <details>
                      <summary>API処理の詳細</summary>
                      <p className="panel-meta">
                        {e.apiFailure.operation} {e.apiFailure.timeframe ?? ""}{" "}
                        ／ 所要時間：{e.apiFailure.elapsedMs} ms ／ 再試行：
                        {e.apiFailure.retryCount ?? "不明"} ／ HTTP：
                        {e.apiFailure.status ?? "応答なし"}
                      </p>
                    </details>
                  )}
                  {e.episode && (
                    <details>
                      <summary>一時停止期間の内訳</summary>
                      <p className="panel-meta">{episodeSummaryText(e.episode)}</p>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </details>
    </div>
  );
}

export function OperationsFeedView({
  api,
  feed,
}: {
  api: SettingsApi;
  feed: OperationsFeed;
}) {
  const { data, state, error, refresh } = feed;
  return (
    <>
      {error && (
        <p className="panel-meta error" role="alert">
          {error}
        </p>
      )}
      {data ? (
        <OperationsView
          data={data}
          state={state}
          stale={!!error}
          api={api}
          refresh={refresh}
        />
      ) : (
        <p className="panel-meta" role="status">
          {error
            ? "状態不明：運用状態を取得できません。"
            : "状態を確認中：運用検証データを取得しています…"}
        </p>
      )}
    </>
  );
}

export function OperationsPanel({ api }: { api: SettingsApi }) {
  const feed = useOperationsFeed(api, true);
  return <OperationsFeedView api={api} feed={feed} />;
}
