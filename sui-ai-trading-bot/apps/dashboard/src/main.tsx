import { ConnectivityStrip } from "./ConnectivityPanel.tsx";
import { DashboardClient } from "./dashboardClient.ts";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { BotEngine } from "../../worker/src/engine.ts";
import { calculate, ema } from "../../../packages/indicators/src/index.ts";
import type { Candle } from "../../../packages/shared/src/index.ts";
import "./style.css";
import {
  dateTime,
  number,
  percent,
  label,
  nextStep,
  errorCode,
} from "./presentation.ts";
import { Reason } from "./Reason.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { OperationsFeedView, useOperationsFeed } from "./OperationsPanel.tsx";
import { AgentNarrationFeed } from "./AgentNarration.tsx";
import { NAV_SHORT_LABELS, NavTabIcon } from "./navTabs.tsx";
import { PriceChart } from "./PriceChart.tsx";
import { BacktestComparison } from "./BacktestComparison.tsx";
import { ProfitGuardPanel } from "./ProfitGuardPanel.tsx";
import { StrategyPanel, useIndicatorHistory } from "./StrategyPanel.tsx";
type State = ReturnType<BotEngine["snapshot"]>;
const NAV_TABS = [
  "Live",
  "Overview",
  "Strategy",
  "Trading History",
  "運用検証",
  "バックテスト比較",
];
const money = (v: number | null | undefined) => number(v, 4);
const precise = (v: string | null | undefined) =>
  v == null ? "不明" : `${number(v)} USDC`;
function IndicatorChart({
  candles,
  kind,
  trades,
}: {
  candles: Candle[];
  kind: string;
  trades: State["trades"];
}) {
  const c = candles.slice(-100);
  if (!c.length) return <div className="empty">確定足の取得を待っています</div>;
  const w = 1000,
    h = 220,
    dx = w / c.length;
  let sets: (number | null)[][] = [],
    min = 0,
    max = 100;
  if (kind === "Price") {
    sets = [
      ema(
        candles.map((x) => x.close),
        20,
      ).slice(-100),
      ema(
        candles.map((x) => x.close),
        50,
      ).slice(-100),
    ];
    min = Math.min(...c.map((x) => x.low));
    max = Math.max(...c.map((x) => x.high));
  } else {
    const indicators = candles
      .map((_, i) => (i >= 59 ? calculate(candles.slice(0, i + 1)) : null))
      .slice(-100);
    sets =
      kind === "RSI"
        ? [indicators.map((x) => x?.rsi ?? null)]
        : [
            indicators.map((x) => x?.macd ?? null),
            indicators.map((x) => x?.signal ?? null),
            indicators.map((x) => x?.histogram ?? null),
          ];
    if (kind === "MACD") {
      min = Math.min(0, ...sets.flat().filter((x): x is number => x !== null));
      max = Math.max(0, ...sets.flat().filter((x): x is number => x !== null));
    }
  }
  const y = (v: number) => h - 15 - ((v - min) / (max - min || 1)) * (h - 30);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`${label(kind)}チャート`}
    >
      <text x="4" y="14" fill="#91a5b6" fontSize="12">
        {money(max)}
      </text>
      <text x="4" y="215" fill="#91a5b6" fontSize="12">
        {money(min)}
      </text>
      {kind === "Price" &&
        c.map((b, i) => (
          <g
            key={b.timestamp}
            stroke={b.close >= b.open ? "#43dfb2" : "#f77d8f"}
          >
            <line
              x1={(i + 0.5) * dx}
              x2={(i + 0.5) * dx}
              y1={y(b.high)}
              y2={y(b.low)}
            />
            <rect
              x={(i + 0.2) * dx}
              width={dx * 0.6}
              y={y(Math.max(b.open, b.close))}
              height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
              fill={b.close >= b.open ? "#43dfb2" : "#f77d8f"}
            />
          </g>
        ))}
      {sets.map((set, j) => (
        <polyline
          key={j}
          fill="none"
          stroke={["#64b5ff", "#edc980", "#b496ee"][j]}
          strokeWidth="1.8"
          points={set
            .flatMap((v, i) =>
              v === null ? [] : [`${(i + 0.5) * dx},${y(v)}`],
            )
            .join(" ")}
        />
      ))}
      {kind === "Price" &&
        trades.map((t) => {
          const i = c.findIndex(
            (b) =>
              t.timestamp / 1000 >= b.timestamp &&
              t.timestamp / 1000 < b.timestamp + b.timeframe,
          );
          return i < 0 ? null : (
            <text
              key={t.orderId}
              x={(i + 0.5) * dx}
              y={y(c[i].close) - 10}
              fill={t.side === "BUY" ? "#43dfb2" : "#f77d8f"}
              fontSize="12"
            >
              <title>
                {label(t.side)} · {dateTime(t.timestamp)}
              </title>
              {t.side === "BUY" ? "▲" : "▼"}
            </text>
          );
        })}
    </svg>
  );
}
function Chart(props: {
  candles: Candle[];
  kind: string;
  trades: State["trades"];
  timeframe?: number;
  synchronized?: boolean;
  historyApi?: import("./settingsPresets.ts").SettingsApi;
}) {
  return props.kind === "Price" ? (
    <PriceChart
      key={props.timeframe ?? props.candles[0]?.timeframe ?? 300}
      {...props}
    />
  ) : (
    <IndicatorChart {...props} />
  );
}
function OrderHistory({ orders }: { orders: Record<string, unknown>[] }) {
  if (!orders.length) return <p>注文はまだありません。</p>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>日時（日本時間）</th>
            <th>方向</th>
            <th>状態</th>
            <th>理由</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o, i) => (
            <tr key={i}>
              <td>{dateTime(o.timestamp as number)}</td>
              <td>{label(o.side)}</td>
              <td>{label(o.status)}</td>
              <td>
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
function App() {
  const [token, setToken] = useState(""),
    [input, setInput] = useState(""),
    [data, setData] = useState<State | null>(null),
    [error, setError] = useState(""),
    [channelError, setChannelError] = useState<string | null>(null),
    [tab, setTab] = useState("Live"),
    [timeframe, setTimeframe] = useState<300 | 900 | 3600>(300);
  // A tab value that no longer exists falls back instead of
  // breaking: the settings tab merged into the strategy tab, so a
  // restored "Settings" opens the strategy tab, and any other
  // unknown value (for example a restored "Chart" from before the
  // chart tab was merged into the dashboard) opens the dashboard.
  const activeTab =
    tab === "Settings" ? "Strategy" : NAV_TABS.includes(tab) ? tab : "Overview";
  const logout = () => {
    setToken("");
    setData(null);
  };
  const feedRef = useRef<DashboardClient | null>(null),
    serialRef = useRef(0),
    viewRef = useRef({ tab: activeTab, timeframe });
  viewRef.current = { tab: activeTab, timeframe };
  const api = useCallback(
    async (path: string, body?: unknown) => {
      const r = await fetch("/api/" + path, {
        signal: path.startsWith("dashboard/")
          ? AbortSignal.timeout(8000)
          : undefined,
        headers: {
          Authorization: "Bearer " + token,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(
          typeof body.error === "string" ? body.error : `HTTP_${r.status}`,
        );
      }
      return r.json();
    },
    [token],
  );
  // One shared operations feed for the narration tab and the
  // operations tab (see useOperationsFeed). It polls only while
  // logged in.
  const operations = useOperationsFeed(api, token !== "");
  // Short indicator history for the strategy tab's mini charts,
  // accumulated at the App level so tab switches keep it.
  const indicatorHistory = useIndicatorHistory(
    operations.data?.decision ?? null,
  );
  async function refresh() {
    const feed = feedRef.current;
    if (!feed) return;
    const serial = ++serialRef.current;
    const view = viewRef.current;
    try {
      const result = await feed.poll(
        api,
        view.tab === "Overview" ? view.timeframe : null,
        ["Overview", "Trading History"].includes(view.tab),
        (state) => {
          if (feedRef.current === feed && serialRef.current === serial) {
            setData(state);
            setError("");
          }
        },
      );
      if (feedRef.current === feed && serialRef.current === serial) {
        setData(result.state);
        setChannelError(result.channelError);
        setError("");
      }
    } catch (e) {
      if (feedRef.current === feed && serialRef.current === serial)
        setError(errorCode(e));
    }
  }
  useEffect(() => {
    if (!token) return;
    feedRef.current = new DashboardClient();
    void refresh();
    const id = setInterval(() => void refresh(), 10000);
    return () => {
      clearInterval(id);
      serialRef.current++;
      feedRef.current = null;
    };
  }, [token]);
  useEffect(() => {
    if (token) void refresh();
  }, [tab, timeframe]);
  async function control(command: string) {
    try {
      serialRef.current++;
      const runtime = await api("control", { command });
      if (typeof runtime?.running === "boolean")
        setData((previous) => (previous ? { ...previous, runtime } : previous));
      await refresh();
    } catch (e) {
      setError(errorCode(e));
    }
  }
  return (
    <>
      <header>
        <div>
          <strong>◈ Sui Paper Lab</strong>
          <small>SUI / ネイティブUSDC · メインネットの市場データ</small>
        </div>
        <span className="badge">PAPER（仮想売買）専用</span>
        <button
          className="danger"
          disabled={!data}
          onClick={() => void control("emergency")}
        >
          緊急停止
        </button>
        {token && (
          <button className="logout-link" onClick={logout}>
            ログアウト
          </button>
        )}
      </header>
      {!token ? (
        <main className="login">
          <h1>市場を検証する。</h1>
          <p>実資金を使わない、ルールベースの取引ラボ。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setToken(input);
              setInput("");
            }}
          >
            <label>
              管理トークン
              <input
                type="password"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <button>接続</button>
          </form>
          <p>トークンはメモリ内でのみ保持します。</p>
        </main>
      ) : (
        <>
          <nav>
            {NAV_TABS.map((t) => {
              const formal = label(t) === "未確認" ? t : label(t);
              return (
                <button
                  className={activeTab === t ? "active" : ""}
                  key={t}
                  aria-label={formal}
                  onClick={() => {
                    setTab(t);
                  }}
                >
                  <NavTabIcon tab={t} />
                  <span className="nav-label-full">{formal}</span>
                  <span className="nav-label-short" aria-hidden="true">
                    {NAV_SHORT_LABELS[t] ?? formal}
                  </span>
                </button>
              );
            })}
            <button className="nav-logout" onClick={logout}>
              ログアウト
            </button>
          </nav>
          <main>
            {channelError && (
              <p role="alert" className="error">
                {channelError}
              </p>
            )}
            {error && (
              <p role="alert" className="error">
                <Reason code={error} />
                接続・管理トークンと運用状態を確認して再試行してください。
              </p>
            )}
            {data && (
              <>
                <div className="title">
                  <div>
                    <small>仮想売買の検証</small>
                    <h1>
                      {label(activeTab) === "未確認"
                        ? activeTab
                        : label(activeTab)}
                    </h1>
                  </div>
                  <span className="status">
                    {error
                      ? "状態不明"
                      : data.runtime.emergency
                        ? "緊急停止"
                        : data.runtime.error
                          ? "安全停止"
                          : data.runtime.running
                            ? "稼働中"
                            : "停止中"}{" "}
                    · gRPC（Sui読み取り接続）
                    {error
                      ? "状態不明（最終取得時点）"
                      : data.connection.healthy
                        ? "接続済み"
                        : "未接続"}
                  </span>
                </div>
                {/* The market-data diagnostics live on the operations
                    tab, and the connectivity safety summary is a thin
                    strip on the dashboard only, so neither panel follows
                    the reader across every tab. The tab-independent
                    emergency / stopped notices below stay as they are. */}
                {activeTab === "Overview" && (
                  <ConnectivityStrip safety={data.safety} stale={!!error} />
                )}
                {data.runtime.emergency && (
                  <p className="error">
                    緊急停止中です。原因と接続状態を確認し、戦略の「停止状態の解除」から解除後、PAPER運用を手動で開始してください。
                  </p>
                )}
                {!data.runtime.running &&
                  !data.runtime.error &&
                  !data.runtime.emergency &&
                  !data.safety?.resumePending && (
                    <p>
                      停止中です。戦略で保存済みの条件を確認し、「PAPER運用開始」を押してください。
                    </p>
                  )}
                {data.runtime.error && (
                  <p className="error">
                    停止理由：
                    <Reason code={data.runtime.error} />
                    次の操作：{nextStep(data.runtime.error)}
                  </p>
                )}
                {/* The narration tab stays mounted (only hidden) so
                    the feed history accumulated from snapshot diffs
                    survives tab switches. */}
                <div className="narration-tab" hidden={activeTab !== "Live"}>
                  {operations.error && (
                    <p className="error" role="alert">
                      {operations.error}
                    </p>
                  )}
                  {operations.data ? (
                    <AgentNarrationFeed
                      data={operations.data}
                      stale={!!operations.error}
                    />
                  ) : (
                    <p role="status">
                      {operations.error
                        ? "状態不明：Botの記録を取得できません。"
                        : "状態を確認中：Botの記録を取得しています…"}
                    </p>
                  )}
                </div>
                {activeTab === "Overview" && (
                  <>
                    <div className="cards">
                      {[
                        ["SUI価格", data.price, "USDC"],
                        ["仮想総資産", data.equity, "USDC"],
                        ["累計損益", data.pnl, "USDC"],
                        [
                          "日次損益（日本時間09:00から）",
                          data.dailyPnl,
                          "USDC",
                        ],
                        ["仮想SUI", data.portfolio.sui, "SUI"],
                        ["仮想USDC", data.portfolio.usdc, "USDC"],
                        [
                          "本日の取引（日本時間09:00から）",
                          data.todayTrades,
                          "件",
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
                    </div>
                    <ProfitGuardPanel data={data} />
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
                        timeframe={timeframe}
                        candles={data.candlesByTimeframe[timeframe]}
                        kind="Price"
                        trades={data.trades}
                        synchronized
                        historyApi={api}
                      />
                    </section>
                    <div className="cards">
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
                  </>
                )}
                {activeTab === "Strategy" && (
                  <>
                    <StrategyPanel
                      data={data}
                      telemetry={operations.data?.decision ?? null}
                      history={indicatorHistory}
                    />
                    <SettingsPage
                      data={data}
                      api={api}
                      onSaved={refresh}
                      control={control}
                    />
                  </>
                )}
                {activeTab === "Trading History" && (
                  <>
                    <section>
                      <h3>仮想約定履歴</h3>
                      <div className="scroll">
                        <table>
                          <thead>
                            <tr>
                              {[
                                "日時",
                                "方向",
                                "数量",
                                "価格",
                                "手数料",
                                "実現損益",
                                "取得原価 / 内訳",
                              ].map((x) => (
                                <th key={x}>{x}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {data.trades.map((t) => (
                              <tr key={t.orderId}>
                                <td>{dateTime(t.timestamp)}</td>
                                <td>{label(t.side)}</td>
                                <td>{money(t.quantity)}</td>
                                <td>{money(t.price)}</td>
                                <td>{money(t.fee)}</td>
                                <td>{money(t.pnl)}</td>
                                <td>
                                  {t.acquisition ? (
                                    <details>
                                      <summary>
                                        {precise(t.acquisition.totalCostUsdc)}
                                      </summary>
                                      <p>
                                        追加手数料{" "}
                                        {precise(t.costs?.additionalFeeUsdc)} /
                                        ガス {precise(t.costs?.gasUsdc)} / DEX{" "}
                                        {t.costs?.dexFeeUsdc == null
                                          ? "内訳不明（見積もり内）"
                                          : precise(t.costs.dexFeeUsdc)}
                                      </p>
                                    </details>
                                  ) : t.allocatedCostUsdc ? (
                                    precise(t.allocatedCostUsdc)
                                  ) : (
                                    "旧履歴：内訳不明"
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                    <section>
                      <h3>注文 / 拒否理由</h3>
                      <OrderHistory orders={data.orders} />
                    </section>
                  </>
                )}
                {activeTab === "バックテスト比較" && (
                  <BacktestComparison token={token} settings={data.settings} />
                )}
                {activeTab === "運用検証" && (
                  <OperationsFeedView api={api} feed={operations} />
                )}
              </>
            )}
          </main>
        </>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
