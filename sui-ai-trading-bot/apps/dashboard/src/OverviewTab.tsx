import type { BotEngine } from "../../worker/src/engine.ts";
import { number, percent, label } from "./presentation.ts";
import { PortfolioMix } from "./PortfolioMix.tsx";
import { EquityCurve } from "./EquityCurve.tsx";
import { ActivityGrass } from "./ActivityGrass.tsx";
import { MonthlyReportCard } from "./MonthlyReportCard.tsx";
import { LongTermChart } from "./LongTermChart.tsx";
import { Chart } from "./IndicatorChart.tsx";
import type { SettingsApi } from "./settingsPresets.ts";
import type { ForecastAnswerCheck } from "./forecastLog.ts";
import type { ShareCardInput } from "./shareCard.ts";

type State = ReturnType<BotEngine["snapshot"]>;
const money = (v: number | null | undefined) => number(v, 4);

/**
 * The overview tab, extracted from App: asset cards, the
 * portfolio mix, the equity curve, the activity grass and
 * monthly report, the synchronized price/RSI/MACD chart with
 * its forecast attachments, the long-term map, and the
 * detailed-metrics fold. Pure rendering over the snapshot.
 */
export function OverviewTab({
  data,
  timeframe,
  setTimeframe,
  api,
  forecastScoreLine,
  forecastTouchLine,
  forecastBandScale,
  forecastAnswer,
  shareCard,
  sellLines,
}: {
  data: State;
  timeframe: 300 | 900 | 3600;
  setTimeframe: (tf: 300 | 900 | 3600) => void;
  api: SettingsApi;
  forecastScoreLine: string | null;
  forecastTouchLine: string | null;
  forecastBandScale: number;
  forecastAnswer: ForecastAnswerCheck | null;
  shareCard: ShareCardInput | null;
  sellLines: { tp: number; sl: number } | null;
}) {
  return (
                  <div className="overview-tab">
                    <div className="cards">
                      {[
                        ["仮想総資産", data.equity, "USDC"],
                        ["累計損益", data.pnl, "USDC"],
                        [
                          "本日の取引（日本時間09:00から）",
                          data.todayTrades,
                          "件",
                        ],
                      ].map(([label, value, unit]) => (
                        <section key={String(label)}>
                          <small>{label}</small>
                          <h2>
                            {money(value as number | null)} <em>{unit}</em>
                          </h2>
                        </section>
                      ))}
                      <section>
                        <small>保有</small>
                        <h2>
                          {money(data.portfolio.sui)}{" "}
                          <em>{data.pair === "WAL_USDC" ? "WAL" : "SUI"}</em>
                        </h2>
                        <p className="overview-sub">
                          {money(data.portfolio.usdc)} USDC
                        </p>
                      </section>
                    </div>
                    <PortfolioMix
                      usdc={data.portfolio.usdc}
                      baseQty={data.portfolio.sui}
                      price={data.price}
                      costBasis={data.portfolio.costBasis}
                      baseSymbol={data.pair === "WAL_USDC" ? "WAL" : "SUI"}
                    />
                    <EquityCurve points={data.equityCurve} />
                    <ActivityGrass orders={data.orders} />
                    <MonthlyReportCard
                      pair={data.pair}
                      trades={data.trades}
                      orders={data.orders}
                    />
                    <label>
                      時間足
                      <select
                        value={timeframe}
                        onChange={(e) =>
                          setTimeframe(
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
                      <Chart
                        pair={data.pair}
                        timeframe={timeframe}
                        candles={data.candlesByTimeframe[timeframe]}
                        kind="Price"
                        trades={data.trades}
                        synchronized
                        historyApi={api}
                        forecastScoreText={forecastScoreLine}
                        forecastTouchText={forecastTouchLine}
                        forecastBandScale={forecastBandScale}
                        answerCheck={forecastAnswer}
                        shareCard={shareCard}
                        bookImbalance={data.bookImbalance}
                        sellLines={sellLines}
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
                    <details className="overview-details">
                      <summary>詳細の数字</summary>
                      <div className="cards">
                        {[
                          [
                            "日次損益（日本時間09:00から）",
                            data.dailyPnl,
                            "USDC",
                          ],
                          ["未実現損益", data.unrealized, "USDC"],
                        ].map(([label, value, unit]) => (
                          <section key={String(label)}>
                            <small>{label}</small>
                            <h2>
                              {money(value as number | null)} <em>{unit}</em>
                            </h2>
                          </section>
                        ))}
                        {Object.entries(data.metrics).map(([k, v]) => (
                          <section key={k}>
                            <small
                              title={
                                k === "maxDrawdown"
                                  ? "資産の最高値からの最大下落率"
                                  : k === "profitFactor"
                                    ? "利益合計を損失合計で割った値"
                                    : "損益を記録した約定のうち利益が出た割合"
                              }
                            >
                              {label(k)}
                            </small>
                            <h2>
                              {k === "profitFactor" ? money(v) : percent(v)}
                            </h2>
                          </section>
                        ))}
                      </div>
                    </details>
                  </div>
  );
}
