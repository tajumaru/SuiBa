import { useState } from "react";
import { WorkerStaleNote } from "./WorkerStaleNote.tsx";
import type { OperationsSnapshot } from "./operationsTypes.ts";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import { number } from "./presentation.ts";
import { PortfolioMix } from "./PortfolioMix.tsx";
import { RealPortfolioMix } from "./RealPortfolioMix.tsx";
import { EquityCurve } from "./EquityCurve.tsx";
import { ActivityGrass } from "./ActivityGrass.tsx";
import { MonthlyReportCard } from "./MonthlyReportCard.tsx";
import { LongTermChart } from "./LongTermChart.tsx";
import { Chart } from "./IndicatorChart.tsx";
import type { SettingsApi } from "./settingsPresets.ts";
import type { ForecastAnswerCheck } from "./forecastLog.ts";
import type { NarrationShadowDiagnostics } from "./narrationShadow.ts";
import { ForceClose } from "./ForceClose.tsx";
import { JpyAmount } from "./JpyAmount.tsx";


type State = BotSnapshot;

const money = (v: number | null | undefined) => number(v, 4);

export function ShadowTodayLine({
  summary,
}: {
  summary: State["shadowToday"];
}) {
  if (!summary) return null;
  return (
    <p className="overview-sub">
      影 本日 {summary.total}件
      {summary.total > 0 && (
        <>
          （AIのみBUY {summary.aiOnlyBuy}件・エラー {summary.errors}件）
        </>
      )}
    </p>
  );
}

export function PnlBreakdownLine({
  totals,
  stale = false,
}: {
  totals?: OperationsSnapshot["accounting"]["totals"] | null;
  stale?: boolean;
}) {
  if (stale || !totals || totals.roundTrips === 0) return null;
  return (
    <p className="overview-sub">
      閉じた往復 {totals.roundTrips}件 ・ 勝率{" "}
      {Math.round((totals.wins / totals.roundTrips) * 100)}% ・ 1回平均{" "}
      {(Number(totals.realizedPnlUsdc) / totals.roundTrips).toFixed(2)} USDC
    </p>
  );
}

/**
 * The overview tab's two segments (owner, 2026-11-22): いま
 * carries the live state (assets, today's shadow line, the
 * price chart and the long-term map); ふりかえり carries the
 * look-back trio he likes but found buried — the equity
 * curve, the activity grass and the monthly report. The
 * stale-data note stays above the switch: it must show
 * whichever segment is open.
 */
export type OverviewSegment = "now" | "review";

const OVERVIEW_SEGMENTS: { id: OverviewSegment; label: string }[] = [
  { id: "now", label: "いま" },
  { id: "review", label: "ふりかえり" },
];

/**
 * The overview tab, extracted from App: asset cards, the
 * portfolio mix, the equity curve, the activity grass and
 * the monthly report, the synchronized price/RSI/MACD chart
 * with its forecast attachments and the long-term map.
 * Pure rendering over the snapshot. (The detailed-metrics
 * fold — daily/unrealized PnL, max drawdown, win rate,
 * profit factor — was retired 2026-11-22: the win rate
 * duplicates the assets card, the rest decided nothing at
 * this scale, and the morning review judges performance.)
 * (The market weather card was retired 2026-11-22: its three
 * numbers already live on the ticker and the conditions, and
 * nothing acted on the grade.)
 */
export function OverviewTab({
  segment,
  onSegmentChange,
  data,
  operations,
  operationsStale = false,
  timeframe,
  setTimeframe,
  api,
  btcHistoryApi,
  control,
  forecastScoreLine,
  forecastTouchLine,
  forecastBandScale,
  forecastAnswer,
  sellLines,
  linePrice,
  narrationShadow,
}: {
  segment: OverviewSegment;
  onSegmentChange: (segment: OverviewSegment) => void;
  data: State;
  operations?: OperationsSnapshot | null;
  operationsStale?: boolean;
  timeframe: 300 | 900 | 3600;
  setTimeframe: (tf: 300 | 900 | 3600) => void;
  api: SettingsApi;
  btcHistoryApi: SettingsApi;
  control: (command: string) => Promise<string | null>;
  forecastScoreLine: string | null;
  forecastTouchLine: string | null;
  forecastBandScale: number;
  forecastAnswer: ForecastAnswerCheck | null;
  sellLines: { tp: number; sl: number } | null;
  linePrice: number | null;
  narrationShadow?: NarrationShadowDiagnostics | null;
}) {
  const [chartAsset, setChartAsset] = useState<"SUI" | "BTC">("SUI");
  const [btcTimeframe, setBtcTimeframe] = useState<300 | 900 | 3600>(300);
  const btcChart = chartAsset === "BTC";
  const real = data.mode === "REAL";
  const usdJpy = operations?.fx?.usdJpy ?? null;
  return (
                  <div className="overview-tab">
                    <WorkerStaleNote data={operations ?? null} stale={operationsStale} />
                    <div
                      className="strategy-segments overview-segments"
                      role="tablist"
                      aria-label="概要ページの表示切替"
                    >
                      {OVERVIEW_SEGMENTS.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          role="tab"
                          id={`overview-segment-${s.id}`}
                          aria-selected={segment === s.id}
                          aria-controls={`overview-segment-panel-${s.id}`}
                          className={segment === s.id ? "active" : ""}
                          onClick={() => onSegmentChange(s.id)}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                    <div
                      role="tabpanel"
                      id="overview-segment-panel-now"
                      aria-labelledby="overview-segment-now"
                      hidden={segment !== "now"}
                    >
                    <ShadowTodayLine summary={data.shadowToday} />
                    {/* 仮想総資産と保有のカードは資産の中身
                        (PortfolioMix) と同じ数字の二重表示だったため
                        2026-11-20 に撤去（オーナー指摘）。本日の取引も
                        単独カードだと 0 件の日に枠だけ大きいため、
                        同日さらに累計損益カードの1行へ統合した。
                        2026-11-22、資産の中身と累計損益を1枚の
                        資産カードへ統合（オーナー指示）：中身が上、
                        区切りの下に損益。 */}
                    {real ? (
                      <RealPortfolioMix
                        balances={data.realBalances}
                        network={data.network}
                        price={data.price}
                      />
                    ) : (
                        <section
                          className="overview-assets-card"
                          aria-label="資産"
                        >
                          <PortfolioMix
                            embedded
                            usdc={data.portfolio.usdc}
                            baseQty={data.portfolio.sui}
                            price={data.price}
                            costBasis={data.portfolio.costBasis}
                            baseSymbol={data.pair === "WAL_USDC" ? "WAL" : "SUI"}
                            usdJpy={usdJpy}
                          />
                          <ForceClose
                            key={data.pair}
                            data={data}
                            control={control}
                          />
                          <div className="overview-assets-pnl">
                            <small>累計損益</small>
                            <h2>
                              <span
                                className={
                                  data.pnl != null && data.pnl < 0
                                    ? "pm-down"
                                    : data.pnl != null && data.pnl > 0
                                      ? "pm-up"
                                      : undefined
                                }
                              >
                                {data.pnl == null ? "—" : data.pnl.toFixed(2)}
                              </span>{" "}
                              <em>USDC</em>
                              <JpyAmount usdc={data.pnl} usdJpy={usdJpy} />
                            </h2>
                            <PnlBreakdownLine
                              totals={operations?.accounting.totals}
                              stale={operationsStale}
                            />
                            <p className="overview-sub">
                              本日の取引（日本時間09:00から）{" "}
                              {money(data.todayTrades)} 件
                            </p>
                          </div>
                        </section>
                    )}
                    <label>
                      時間足
                      <select
                        value={btcChart ? btcTimeframe : timeframe}
                        onChange={(e) =>
                          (btcChart ? setBtcTimeframe : setTimeframe)(
                            Number(e.target.value) as 300 | 900 | 3600,
                          )
                        }
                      >
                        <option value={300}>5分</option>
                        <option value={900}>15分</option>
                        <option value={3600}>1時間</option>
                      </select>
                    </label>
                    <section>
                      <h3>価格・RSI・MACD（共通時間軸）</h3>
                      <div className="chart-asset-switch" role="group" aria-label="チャートの表示銘柄">
                        {(["SUI", "BTC"] as const).map((asset) => (
                          <button
                            key={asset}
                            type="button"
                            aria-pressed={chartAsset === asset}
                            onClick={() => setChartAsset(asset)}
                          >
                            {asset}
                          </button>
                        ))}
                      </div>
                      {btcChart && (
                        <Chart
                          key="btc"
                          pair="XBTC_USDC"
                          timeframe={btcTimeframe}
                          candles={[]}
                          kind="Price"
                          trades={[]}
                          synchronized
                          historyApi={btcHistoryApi}
                        />
                      )}
                      <Chart
                        hidden={btcChart}
                        key="sui"
                        pair={data.pair}
                        timeframe={timeframe}
                        candles={data.candlesByTimeframe[timeframe]}
                        kind="Price"
                        trades={data.trades}
                        synchronized
                        historyApi={api}
                        forecastScoreText={forecastScoreLine}
                        forecastTouchText={forecastTouchLine}
                        forecast={data.forecast?.cones[timeframe]}
                        forecastBandScale={forecastBandScale}
                        answerCheck={forecastAnswer}
                        bookImbalance={data.bookImbalance}
                        sellLines={sellLines}
                        linePrice={linePrice}
                        oversold={data.settings.oversold}
                      />
                    </section>
                    {data.longTermDaily && data.longTermDaily.length >= 30 && (
                      <section>
                        <h3>長期マップ（週足と水準）</h3>
                        <LongTermChart
                          daily={data.longTermDaily}
                          price={
                            data.candlesByTimeframe[300]?.at(-1)?.close ??
                            null
                          }
                        />
                      </section>
                    )}
                    {import.meta.env.DEV && narrationShadow && (
                      <details className="overview-details">
                        <summary>開発診断：実況 read shadow</summary>
                        <pre>{JSON.stringify(narrationShadow, null, 2)}</pre>
                      </details>
                    )}
                    </div>
                    <div
                      role="tabpanel"
                      id="overview-segment-panel-review"
                      aria-labelledby="overview-segment-review"
                      hidden={segment !== "review"}
                    >
                    {!real && <EquityCurve points={data.equityCurve} />}
                    <ActivityGrass orders={data.orders} />
                    <MonthlyReportCard
                      pair={data.pair}
                      trades={data.trades}
                      orders={data.orders}
                      cumulativeRoundTrips={
                        operations?.accounting.totals.roundTrips
                      }
                    />
                    </div>
                  </div>
  );
}
