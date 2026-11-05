import { OperationBar } from "./OperationBar.tsx";
import { recoveryStatus } from "./recoveryState.ts";
import { VITAL_RECEIPT_FRESH_MS } from "./botVital.ts";
import { PriceTicker } from "./PriceTicker.tsx";
import { LoginScreen } from "./LoginScreen.tsx";
import { loginSession, SESSION } from "./browserSession.ts";
import { DashboardClient } from "./dashboardClient.ts";
import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import "./style.css";
import { label, errorCode } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
import type { StrategySegment } from "./StrategyTab.tsx";
import { useOperationsFeed } from "./operationsFeed.ts";
import { useForecastSuite } from "./useForecastSuite.ts";
import { OverviewTab } from "./OverviewTab.tsx";
import { AppHeader } from "./AppHeader.tsx";
import { AgentNarrationFeed } from "./AgentNarration.tsx";
import { BootScreen } from "./BootScreen.tsx";

import { useUpdateCheck } from "./appVersion.ts";
import { UpdateBanner, VersionFooter } from "./VersionFooter.tsx";
import { ChainStrip } from "./ChainStrip.tsx";
import { BookBar } from "./BookBar.tsx";
import {
  loadAgentName,
  sanitizeAgentName,
  saveAgentName,
} from "./agentName.ts";
import { errorShout } from "./errorShout.ts";

import {
  BUY_CELEBRATION_MS,
  sellLinesOf,
  type AgentPose,
} from "./agentNarration.ts";
import { NAV_SHORT_LABELS, NavTabIcon } from "./navTabs.tsx";
/* Secondary tabs load on first open, keeping the initial
 * bundle to the shell, the live feed and the overview. */
const StrategyTab = lazy(() =>
  import("./StrategyTab.tsx").then((m) => ({ default: m.StrategyTab })),
);
const HistoryTab = lazy(() =>
  import("./HistoryTab.tsx").then((m) => ({ default: m.HistoryTab })),
);
const BacktestComparison = lazy(() =>
  import("./BacktestComparison.tsx").then((m) => ({
    default: m.BacktestComparison,
  })),
);
const OperationsFeedView = lazy(() =>
  import("./OperationsPanel.tsx").then((m) => ({
    default: m.OperationsFeedView,
  })),
);
const tabFallback = (
  <p className="tab-loading" role="status">
    読み込み中…
  </p>
);
import { useIndicatorHistory } from "./indicatorHistory.ts";
type State = BotSnapshot;
const NAV_TABS = [
  "Live",
  "Overview",
  "Strategy",
  "Trading History",
  "運用検証",
  "バックテスト比較",
];
function App() {
  const update = useUpdateCheck();
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
        ) {
          setToken(SESSION);
          setBooting(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setRestoringSession(false);
      });
    return () => controller.abort();
  }, []);
  const [token, setToken] = useState(""),
    // The boot sequence overlays the shell once per login
    // session (form login and session restore alike).
    [booting, setBooting] = useState(false),
    [data, setData] = useState<State | null>(null),
    [error, setError] = useState(""),
    // Operation failures do not invalidate a successfully fetched state.
    // Start refusals are explained locally by the operation bar.
    [bannerError, setBannerError] = useState(""),
    [pairBusy, setPairBusy] = useState(false),
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
  // The character's user-chosen name (device-local; "" = キャラ).
  const [agentName, setAgentName] = useState<string>(() => loadAgentName());
  // Voice recognition is live in the chat (the avatar listens).
  const [voiceListening, setVoiceListening] = useState(false);
  // A spoken reply is playing (the avatar is mid-speech).
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const {
    forecastInput,
    calibEvent,
    forecastScoreLine,
    forecastTouchLine,
    forecastCalib,
    forecastAnswer,
    shareCard,
  } = useForecastSuite(data, agentName);
  const changeAgentName = (raw: string) => {
    const next = sanitizeAgentName(raw);
    saveAgentName(next);
    setAgentName(next);
  };
  // Line mode: while the buy-run line stands (the feed reports
  // the buyLine pose), the whole page washes Sui blue — the
  // avatar's blue pose grown into an ambient theme. The class
  // lives on <html> so the header, bars and bottom nav all join.
  useEffect(() => {
    document.documentElement.classList.toggle(
      "line-mode",
      agentPose === "buyLine",
    );
    return () => document.documentElement.classList.remove("line-mode");
  }, [agentPose]);
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
  const pairRef = useRef<State["pair"] | undefined>(undefined);
  pairRef.current = data?.pair;
  const api = useCallback(
    async (path: string, body?: unknown) => {
      const r = await fetch("/api/" + path, {
        signal: body ? undefined : AbortSignal.timeout(8000),
        headers: {
          ...(token !== SESSION ? { Authorization: "Bearer " + token } : {}),
          "X-SuiBa-Request": "1",
          ...(pairRef.current ? { "X-SuiBa-Pair": pairRef.current } : {}),
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
        if (body.error === "PAIR_CHANGED") window.location.reload();
        throw new Error(
          typeof body.error === "string" ? body.error : `HTTP_${r.status}`,
        );
      }
      const value = await r.json();
      const responsePair = value.summary?.pair ?? value.pair;
      if (pairRef.current && responsePair && responsePair !== pairRef.current) {
        window.location.reload();
        throw Error("PAIR_CHANGED");
      }
      return value;
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
    // Catch acquisition completion promptly. One follow-up per received
    // snapshot avoids stacking requests when the local API itself is slow.
    if (!token || stateStale || data?.safety?.marketUpdating !== true) return;
    const timer = window.setTimeout(() => void refresh(), 1000);
    return () => window.clearTimeout(timer);
  }, [token, receivedAt, data?.safety?.marketUpdating, stateStale]);
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
  // Pair switching reloads the app: the pair scopes every request
  // (see the X-SuiBa-Pair header in refresh), so a clean reload is
  // the honest way to land on the other pair's state. A rejected
  // switch keeps the specific reason in the banner.
  async function switchPair(pair: string) {
    setPairBusy(true);
    setBannerError("");
    // STOP_AND_WAIT_BEFORE_PAIR_SWITCH is the server's "not right
    // now" gate: it also fires for purely transient collisions —
    // this dashboard's own state poll in flight, an engine tick
    // running, a short API backoff — which usually clear within a
    // couple of seconds. Wait and retry a few times before
    // bothering the user; the endpoint answers a no-op success
    // when the pair is already selected, so retrying the same
    // target can never switch twice.
    for (let tries = 0; ; tries++) {
      try {
        await api("pairs", { pair });
        window.location.reload();
        return;
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "STOP_AND_WAIT_BEFORE_PAIR_SWITCH" && tries < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        setBannerError(
          code === "PAIR_POSITION_OPEN"
            ? "未決済ポジションまたは未精算の原価が残っています。対象ペアで決済・会計確認を完了してから切り替えてください。"
            : code === "PAIR_PENDING_WORK" || code === "PAIR_INVALID_LEDGER"
              ? "未処理注文または会計の確認が必要です。運用検証で対象ペアを確認してください。"
              : code === "STOP_AND_WAIT_BEFORE_PAIR_SWITCH"
                ? "切り替えの準備が整いませんでした。市場データの取得が落ち着いてから、もう一度タップしてください。"
                : "ペアを切り替えられません。売買を停止し、市場データ取得の完了後に再試行してください。",
        );
        setPairBusy(false);
        return;
      }
    }
  }
  return (
    <>
      {update && <UpdateBanner served={update} />}
      <AppHeader
        data={data}
        token={token}
        control={control}
        logout={logout}
        agentPose={agentPose}
        buyCelebration={buyCelebration}
        shout={shout}
        agentName={agentName}
        changeAgentName={changeAgentName}
        voiceListening={voiceListening}
        agentSpeaking={agentSpeaking}
      />
      {restoringSession ? (
        <p role="status">ログイン状態を確認しています…</p>
      ) : !token ? (
        <LoginScreen
          verify={loginSession}
          onAuthenticated={() => {
            setToken(SESSION);
            setBooting(true);
          }}
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
                  pair={data.pair}
                  pairDisabled={pairBusy || data.runtime.running}
                  onPairSwitch={(pair) => void switchPair(pair)}
                  price={data.price}
                  marketData={data.marketData}
                  now={now}
                  candlesByTimeframe={data.candlesByTimeframe}
                  glow={buyCelebration}
                  linePrice={operations.data?.decision?.rsiLinePrice ?? null}
                  sellLines={
                    operations.data?.decision
                      ? sellLinesOf(operations.data.decision)
                      : null
                  }
                />
                {/* The chain's own vital signs ride under the
                    ticker on every tab (display only). */}
                <ChainStrip chain={data.chain} />
                {/* The order book's lean, same sample that
                    tilts the model outlook (display only). */}
                <BookBar imbalance={data.bookImbalance} />
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
                      pairLabel={data?.pair === "WAL_USDC" ? "WAL" : "SUI"}
                      chain={data?.chain ?? null}
                      trades={data?.trades ?? []}
                      btc={data?.btc ?? null}
                      book={data?.bookLevels ?? null}
                      forecasts={forecastInput}
                      calibEvent={calibEvent}
                      active={activeTab === "Live"}
                      agentName={agentName}
                      onListeningChange={setVoiceListening}
                      onSpeakingChange={setAgentSpeaking}
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
                  <OverviewTab
                    data={data}
                    timeframe={timeframe}
                    setTimeframe={setTimeframe}
                    api={api}
                    forecastScoreLine={forecastScoreLine}
                    forecastTouchLine={forecastTouchLine}
                    forecastBandScale={forecastCalib.scale}
                    forecastAnswer={forecastAnswer}
                    shareCard={shareCard}
                    sellLines={
                      operations.data?.decision
                        ? sellLinesOf(operations.data.decision)
                        : null
                    }
                  />
                )}
                {activeTab === "Strategy" && (
                  <Suspense fallback={tabFallback}>
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
                  </Suspense>
                )}
                {activeTab === "Trading History" && (
                  <Suspense fallback={tabFallback}>
                    <HistoryTab
                      orders={data.orders}
                      trades={data.trades}
                      candles={data.candlesByTimeframe[300]}
                    />
                  </Suspense>
                )}
                {activeTab === "バックテスト比較" && (
                  <Suspense fallback={tabFallback}>
                    <BacktestComparison
                      token={token}
                      settings={data.settings}
                    />
                  </Suspense>
                )}
                {activeTab === "運用検証" && (
                  <Suspense fallback={tabFallback}>
                    <OperationsFeedView api={api} feed={operations} />
                  </Suspense>
                )}
              </>
            )}
          </main>
        </>
      )}
      <VersionFooter workerBuild={operations.data?.workerBuild ?? null} />
      {token && booting && (
        <BootScreen
          pairLabel={data?.pair === "WAL_USDC" ? "WAL / USDC" : "SUI / USDC"}
          api={operations.data ? "ok" : operations.error ? "error" : "pending"}
          bot={
            !data
              ? "unknown"
              : data.runtime.emergency
                ? "emergency"
                : data.runtime.error
                  ? "error"
                  : data.runtime.running
                    ? "running"
                    : "stopped"
          }
          onDone={() => setBooting(false)}
          agentName={agentName}
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
