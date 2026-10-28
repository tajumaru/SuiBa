import { OperationBar } from "./OperationBar.tsx";
import { recoveryStatus } from "./recoveryState.ts";
import { VITAL_RECEIPT_FRESH_MS } from "./botVital.ts";
import { PriceTicker } from "./PriceTicker.tsx";
import { LoginScreen } from "./LoginScreen.tsx";
import { loginSession, SESSION } from "./browserSession.ts";
import { DashboardClient } from "./dashboardClient.ts";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { BotEngine } from "../../worker/src/engine.ts";
import { calculate, ema } from "../../../packages/indicators/src/index.ts";
import type { Candle } from "../../../packages/shared/src/index.ts";
import "./style.css";
import { dateTime, number, percent, label, errorCode } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
import { StrategyTab, type StrategySegment } from "./StrategyTab.tsx";
import { OperationsFeedView, useOperationsFeed } from "./OperationsPanel.tsx";
import { AgentNarrationFeed, AgentHeaderAvatar } from "./AgentNarration.tsx";
import { errorShout } from "./errorShout.ts";
import {
  BUY_CELEBRATION_MS,
  sellLinesOf,
  type AgentPose,
} from "./agentNarration.ts";
import { NAV_SHORT_LABELS, NavTabIcon } from "./navTabs.tsx";
import { PriceChart } from "./PriceChart.tsx";
import { BacktestComparison } from "./BacktestComparison.tsx";
import { useIndicatorHistory } from "./StrategyPanel.tsx";
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
            <tr key={i} role="row">
              <td role="cell" data-label="日時" className="history-wide">
                {dateTime(o.timestamp as number)}
              </td>
              <td role="cell" data-label="方向">
                {label(o.side)}
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
function App() {
  const [restoringSession, setRestoringSession] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/session", {
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    })
      .then(async (r) => {
        if (
          r.ok &&
          (await r.json()).authenticated === true &&
          !controller.signal.aborted
        )
          setToken(SESSION);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setRestoringSession(false);
      });
    return () => controller.abort();
  }, []);
  const [token, setToken] = useState(""),
    [data, setData] = useState<State | null>(null),
    [error, setError] = useState(""),
    // Operation failures do not invalidate a successfully fetched state.
    // Start refusals are explained locally by the operation bar.
    [bannerError, setBannerError] = useState(""),
    [channelError, setChannelError] = useState<string | null>(null),
    [tab, setTab] = useState("Live"),
    [timeframe, setTimeframe] = useState<300 | 900 | 3600>(300),
    // The operation bar's client-side start gate: the strategy
    // tab's settings editor reports its blocks here while it is
    // mounted (unsaved edits and friends), and clears them when
    // the tab closes, so the bar never starts past an open editor.
    [startBlocked, setStartBlocked] = useState<string[]>([]);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const [openDiagnostics, setOpenDiagnostics] = useState(false);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1000);
    window.addEventListener("pageshow", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pageshow", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const stateStale =
    !!error ||
    (data !== null &&
      (receivedAt === null ||
        now < receivedAt ||
        now - receivedAt > VITAL_RECEIPT_FRESH_MS));
  const recovery = recoveryStatus(data, stateStale, checking);
  // A tab value that no longer exists falls back instead of
  // breaking: the settings tab merged into the strategy tab, so a
  // restored "Settings" opens the strategy tab on its 設定
  // segment, and any other unknown value (for example a restored
  // "Chart" from before the chart tab was merged into the
  // dashboard) opens the dashboard.
  const activeTab =
    tab === "Settings" ? "Strategy" : NAV_TABS.includes(tab) ? tab : "Overview";
  // The strategy tab's segment: ルール by default, or 設定 when
  // arriving through the restored "Settings" value, until the
  // reader picks a segment explicitly.
  const [strategySegmentChoice, setStrategySegmentChoice] =
    useState<StrategySegment | null>(null);
  const strategySegment: StrategySegment =
    strategySegmentChoice ?? (tab === "Settings" ? "settings" : "rules");
  const logout = async () => {
    try {
      const response = await fetch("/api/auth/session", {
        method: "DELETE",
        headers: { "X-SuiBa-Request": "1" },
      });
      if (!response.ok && response.status !== 401)
        throw Error(`HTTP_${response.status}`);
      setToken("");
      setData(null);
    } catch (e) {
      setBannerError(errorCode(e));
    }
  };
  // The header avatar's pose, reported by the narration feed — the
  // one place that advances the narration state — so the header and
  // the feed can never show different poses. Before the feed first
  // reports (no snapshot yet), the unconfirmed "normal" pose shows.
  const [agentPose, setAgentPose] = useState<AgentPose>("normal");
  // The buy celebration window, opened by the narration feed when
  // a brand-new recorded buy fill joins it this session. While it
  // runs, the header avatar borrows the smile and the price ticker
  // glows; the pose reporting itself never pauses, so the moment
  // the window closes the avatar shows the pose the records call
  // for at that point.
  const [buyCelebration, setBuyCelebration] = useState(false);
  // The header character's error shout, derived from the same
  // safety snapshot the connectivity displays use (plus this
  // screen's own fetch failure as staleness), so the avatar,
  // the strip and the bar always agree about an error state.
  const shout = errorShout(data?.safety ?? null, stateStale);
  const buyCelebrationTimerRef = useRef<number | null>(null);
  const handleBuyCelebration = useCallback(() => {
    setBuyCelebration(true);
    if (buyCelebrationTimerRef.current != null)
      window.clearTimeout(buyCelebrationTimerRef.current);
    buyCelebrationTimerRef.current = window.setTimeout(
      () => setBuyCelebration(false),
      BUY_CELEBRATION_MS,
    );
  }, []);
  useEffect(
    () => () => {
      if (buyCelebrationTimerRef.current != null)
        window.clearTimeout(buyCelebrationTimerRef.current);
    },
    [],
  );
  const feedRef = useRef<DashboardClient | null>(null),
    serialRef = useRef(0),
    viewRef = useRef({ tab: activeTab, timeframe });
  viewRef.current = { tab: activeTab, timeframe };
  const api = useCallback(
    async (path: string, body?: unknown) => {
      const r = await fetch("/api/" + path, {
        signal: body ? undefined : AbortSignal.timeout(8000),
        headers: {
          ...(token !== SESSION ? { Authorization: "Bearer " + token } : {}),
          "X-SuiBa-Request": "1",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) {
        if (r.status === 401) {
          setToken("");
          setData(null);
        }
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
  useEffect(() => {
    if (!openDiagnostics || activeTab !== "運用検証") return;
    const details = document.getElementById(
      "operation-diagnostics",
    ) as HTMLDetailsElement | null;
    if (!details) return;
    details.open = true;
    details.querySelector("summary")?.focus({ preventScroll: true });
    details.scrollIntoView({ block: "start" });
    setOpenDiagnostics(false);
  }, [openDiagnostics, activeTab, operations.data, data]);
  async function refreshStatus() {
    if (checking) return;
    setChecking(true);
    await Promise.allSettled([refresh(), operations.refresh()]);
    setChecking(false);
  }
  function diagnose() {
    setTab("運用検証");
    setOpenDiagnostics(true);
    void refreshStatus();
  }
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
            setReceivedAt(Date.now());
            setNow(Date.now());
            setError("");
            setBannerError("");
          }
        },
      );
      if (feedRef.current === feed && serialRef.current === serial) {
        setData(result.state);
        setChannelError(result.channelError);
        setError("");
        setBannerError("");
      }
    } catch (e) {
      if (feedRef.current === feed && serialRef.current === serial) {
        setError(errorCode(e));
        setBannerError(errorCode(e));
      }
    }
  }
  useEffect(() => {
    if (!token) return;
    feedRef.current = new DashboardClient();
    setData(null);
    setReceivedAt(null);
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
  // Resolves to null on success, or to the server's machine-readable
  // error code on failure, so the surface that issued the command
  // (for example the PAPER operation controls) can show the reason
  // where the operator acted. A refused start is that surface's
  // story alone — the operation bar tells it with the specific next
  // step — so it does not also raise the global error banner; other
  // commands (stop, emergency, release) keep the banner, having no
  // local surface of their own.
  async function control(command: string): Promise<string | null> {
    try {
      serialRef.current++;
      const runtime = await api("control", { command });
      if (typeof runtime?.running === "boolean")
        setData((previous) => (previous ? { ...previous, runtime } : previous));
      await refresh();
      return null;
    } catch (e) {
      const code = errorCode(e);
      if (command !== "start") setBannerError(code);
      return code;
    }
  }
  return (
    <>
      <header>
        <div className="header-row header-row-main">
          <strong>◈ Sui Paper Lab</strong>
          <span className="badge">PAPER（仮想売買）専用</span>
        </div>
        <div className="header-row header-row-sub">
          <button
            className="danger"
            disabled={!data}
            onClick={() => void control("emergency")}
          >
            緊急停止
          </button>
          <small className="header-meta">
            SUI / ネイティブUSDC · メインネットの市場データ
          </small>
          {token && (
            <button className="logout-link" onClick={logout}>
              ログアウト
            </button>
          )}
        </div>
      </header>
      {/* The narration character rides at the top centre of the app
          as a round avatar, on every tab — but only once connected:
          the login screen has no bot state to show, so no avatar
          (and no placeholder) is rendered. It is a sibling of the
          header, not a child, so its sticky dock (see
          .agent-avatar-dock in style.css) can travel the whole
          page: at rest it floats half over the header's bottom
          edge, and on scroll it sticks to the top of the viewport
          instead of scrolling away with the header. */}
      {token && (
        <AgentHeaderAvatar
          pose={agentPose}
          celebrating={buyCelebration}
          shout={shout}
        />
      )}
      {restoringSession ? (
        <p role="status">ログイン状態を確認しています…</p>
      ) : !token ? (
        <LoginScreen
          verify={loginSession}
          onAuthenticated={() => setToken(SESSION)}
        />
      ) : (
        <>
          <nav className="has-avatar">
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
          <main className="has-avatar">
            {channelError && (
              <p role="alert" className="error">
                {channelError}
              </p>
            )}
            {bannerError && !error && (
              <p role="alert" className="error">
                <Reason code={bannerError} />
                操作を完了できませんでした。最新状態と通信診断を確認してください。
              </p>
            )}
            {!data && activeTab === "運用検証" && (
              <OperationsFeedView api={api} feed={operations} />
            )}
            {data && (
              <>
                {/* The PAPER operation bar rides at the top of the
                    content on every tab and is the single home of
                    the operation state and its start/stop actions
                    (the strategy tab's old panel is gone; the tab
                    keeps only the stop-state release section and
                    reports its editor's start blocks up here). It
                    renders with the first snapshot, like the
                    tab-independent notices below. */}
                <OperationBar
                  runtime={data.runtime}
                  control={control}
                  onOpenStrategy={() => setTab("Strategy")}
                  startBlocked={startBlocked}
                  recovery={recovery}
                  onDiagnose={diagnose}
                />
                {/* The SUI price ticker rides directly under the
                    operation bar on every tab, under the same
                    condition (first snapshot arrived). It reads
                    only what this state already holds — snapshot
                    price plus the recorded candle frames — and
                    hides its change/sparkline until a frame can
                    ground them. */}
                <PriceTicker
                  price={data.price}
                  candlesByTimeframe={data.candlesByTimeframe}
                  glow={buyCelebration}
                  linePrice={operations.data?.decision?.rsiLinePrice ?? null}
                  sellLines={
                    operations.data?.decision
                      ? sellLinesOf(operations.data.decision)
                      : null
                  }
                />
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
                      onPoseChange={setAgentPose}
                      onCelebrate={handleBuyCelebration}
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
                  <StrategyTab
                    data={data}
                    api={api}
                    onSaved={refresh}
                    control={control}
                    telemetry={operations.data?.decision ?? null}
                    history={indicatorHistory}
                    segment={strategySegment}
                    onSegmentChange={setStrategySegmentChoice}
                    onStartGateChange={setStartBlocked}
                  />
                )}
                {activeTab === "Trading History" && (
                  <section>
                    <h3>注文 / 拒否理由</h3>
                    <OrderHistory orders={data.orders} />
                  </section>
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
