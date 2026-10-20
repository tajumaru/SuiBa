import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { BotEngine } from "../../worker/src/engine.ts";
import { calculate, ema } from "../../../packages/indicators/src/index.ts";
import type { Candle } from "../../../packages/shared/src/index.ts";
import "./style.css";
type State = ReturnType<BotEngine["snapshot"]>;
const money = (v: number | null | undefined) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(v);
function Chart({
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
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${kind} chart`}>
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
              {t.side === "BUY" ? "▲" : "▼"}
            </text>
          );
        })}
    </svg>
  );
}
function App() {
  const [token, setToken] = useState(""),
    [input, setInput] = useState(""),
    [data, setData] = useState<State | null>(null),
    [error, setError] = useState(""),
    [tab, setTab] = useState("Overview"),
    [timeframe, setTimeframe] = useState<300 | 900 | 3600>(300),
    [draft, setDraft] = useState("");
  async function api(path: string, body?: unknown) {
    const r = await fetch("/api/" + path, {
      headers: {
        Authorization: "Bearer " + token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`API ${r.status}`);
    return r.json();
  }
  async function refresh() {
    try {
      setData(await api("state"));
      setError("");
    } catch {
      setError(
        "APIに接続できません。トークンとWorkerの状態を確認してください。",
      );
    }
  }
  useEffect(() => {
    if (!token) return;
    void refresh();
    const id = setInterval(() => void refresh(), 10000);
    return () => clearInterval(id);
  }, [token]);
  async function control(command: string) {
    try {
      await api("control", { command });
      await refresh();
    } catch {
      setError("操作を拒否しました。停止状態・接続状態を確認してください。");
    }
  }
  return (
    <>
      <header>
        <div>
          <strong>◈ Sui Paper Lab</strong>
          <small>SUI / Native USDC · Mainnet data</small>
        </div>
        <span className="badge">PAPER ONLY</span>
        <button
          className="danger"
          disabled={!data}
          onClick={() => void control("emergency")}
        >
          緊急停止
        </button>
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
            {[
              "Overview",
              "Chart",
              "Strategy",
              "Trading History",
              "Settings",
            ].map((t) => (
              <button
                className={tab === t ? "active" : ""}
                key={t}
                onClick={() => {
                  setTab(t);
                  if (t === "Settings" && data)
                    setDraft(JSON.stringify(data.settings, null, 2));
                }}
              >
                {t}
              </button>
            ))}
            <button
              onClick={() => {
                setToken("");
                setData(null);
              }}
            >
              ログアウト
            </button>
          </nav>
          <main>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            {data && (
              <>
                <div className="title">
                  <div>
                    <small>RESEARCH WORKSPACE</small>
                    <h1>{tab}</h1>
                  </div>
                  <span className="status">
                    {data.runtime.emergency
                      ? "緊急停止"
                      : data.runtime.error
                        ? "安全停止"
                        : data.runtime.running
                          ? "稼働中"
                          : "停止中"}{" "}
                    · gRPC {data.connection.healthy ? "接続済" : "未接続"}
                  </span>
                </div>
                {data.runtime.error && (
                  <p className="error">
                    {data.runtime.error} —
                    外部データを確認後に停止解除してください。
                  </p>
                )}
                {tab === "Overview" && (
                  <>
                    <div className="cards">
                      {[
                        ["SUI価格", data.price, "USDC"],
                        ["仮想総資産", data.equity, "USDC"],
                        ["累計損益", data.pnl, "USDC"],
                        ["日次損益", data.dailyPnl, "USDC"],
                        ["仮想SUI", data.portfolio.sui, "SUI"],
                        ["仮想USDC", data.portfolio.usdc, "USDC"],
                        ["本日の取引", data.todayTrades, "件"],
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
                    <section>
                      <h3>
                        SUI / USDC <small>5m · EMA20 / EMA50</small>
                      </h3>
                      <Chart
                        candles={data.candles}
                        kind="Price"
                        trades={data.trades}
                      />
                    </section>
                    <div className="cards">
                      {Object.entries(data.metrics).map(([k, v]) => (
                        <section key={k}>
                          <small>{k}</small>
                          <h2>{money(v)}</h2>
                        </section>
                      ))}
                    </div>
                  </>
                )}
                {tab === "Chart" && (
                  <label>
                    時間足
                    <select
                      value={timeframe}
                      onChange={(e) =>
                        setTimeframe(Number(e.target.value) as 300 | 900 | 3600)
                      }
                    >
                      <option value={300}>5分</option>
                      <option value={900}>15分</option>
                      <option value={3600}>1時間</option>
                    </select>
                  </label>
                )}
                {tab === "Chart" &&
                  ["Price", "RSI", "MACD"].map((kind) => (
                    <section key={kind}>
                      <h3>
                        {kind} · 確定{timeframe / 60}分足
                      </h3>
                      <Chart
                        candles={data.candlesByTimeframe[timeframe]}
                        kind={kind}
                        trades={data.trades}
                      />
                    </section>
                  ))}
                {tab === "Strategy" && (
                  <section>
                    <h3>RuleBasedStrategy</h3>
                    <p>
                      EMA20 /
                      EMA50、RSIの閾値交差、MACD方向、出来高異常を組み合わせます。
                    </p>
                    <pre>{JSON.stringify(data.decision, null, 2)}</pre>
                    <h3>戦略パラメータ</h3>
                    <pre>{JSON.stringify(data.settings, null, 2)}</pre>
                    <p>DeepSeek：未実装（拡張用インターフェースのみ）</p>
                  </section>
                )}
                {tab === "Trading History" && (
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
                              ].map((x) => (
                                <th key={x}>{x}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {data.trades.map((t) => (
                              <tr key={t.orderId}>
                                <td>
                                  {new Date(t.timestamp).toLocaleString(
                                    "ja-JP",
                                  )}
                                </td>
                                <td>{t.side}</td>
                                <td>{money(t.quantity)}</td>
                                <td>{money(t.price)}</td>
                                <td>{money(t.fee)}</td>
                                <td>{money(t.pnl)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                    <section>
                      <h3>注文 / 拒否理由</h3>
                      <pre>{JSON.stringify(data.orders, null, 2)}</pre>
                    </section>
                  </>
                )}
                {tab === "Settings" && (
                  <section>
                    <h3>Bot操作</h3>
                    <div className="controls">
                      <button onClick={() => void control("start")}>
                        開始
                      </button>
                      <button onClick={() => void control("stop")}>停止</button>
                      <button onClick={() => void control("reset")}>
                        停止解除（再開は手動）
                      </button>
                    </div>
                    <p>
                      日次区切り：UTC 00:00。設定の上限は初期安全値までです。
                    </p>
                    <label>
                      戦略
                      <select disabled value="rule-based">
                        <option>rule-based</option>
                        <option disabled>deepseek（未実装）</option>
                      </select>
                    </label>
                    <label>
                      パラメータ
                      <textarea
                        rows={22}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                    </label>
                    <button
                      onClick={async () => {
                        try {
                          await api("settings", JSON.parse(draft));
                          await refresh();
                        } catch {
                          setError(
                            "設定を拒否しました。形式と安全上限を確認してください。",
                          );
                        }
                      }}
                    >
                      設定を保存
                    </button>
                  </section>
                )}
              </>
            )}
          </main>
        </>
      )}
      <footer>
        PAPER MODE · 仮想売買のみ · 署名 / 取引送信なし · Market data by
        GeckoTerminal
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
