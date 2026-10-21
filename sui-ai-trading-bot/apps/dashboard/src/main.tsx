import React, { useState, useEffect, useCallback } from "react";
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
import { SettingsPage, SettingsChanges } from "./SettingsPage.tsx";
import { OperationsPanel } from "./OperationsPanel.tsx";
import { MarketDataPanel } from "./MarketDataPanel.tsx";
import { BacktestComparison } from "./BacktestComparison.tsx";
type State = ReturnType<BotEngine["snapshot"]>;
const money = (v: number | null | undefined) => number(v, 4);
const precise = (v: string | null | undefined) =>
  v == null ? "不明" : `${number(v)} USDC`;
function ProfitGuardPanel({ data }: { data: State }) {
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
            {(
              {
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
                MINIMUM_NET_PROFIT_NOT_MET:
                  "手数料控除後の利益が最低条件に届きません",
                PROTECTIVE_EXIT_PROFIT_BYPASS:
                  "損切り・リスク削減のため利益条件は適用しません",
                PROTECTIVE_EXIT_PROFIT_DATA_UNAVAILABLE:
                  "リスク削減のための売却は利益条件の対象外です。見積もり・リスク制限の確認は別途必要です",
                PROFIT_DATA_UNKNOWN: "ガス代・見積もり・原価などが不明です",
                PROJECTED_NET_EXCEEDS_ROUND_TRIP_COST:
                  "想定利確時の純利益が往復コストを上回ります",
                PROJECTED_NET_INSUFFICIENT:
                  "想定利確時の純利益が往復コストまたは最低条件に届きません",
              } as Record<string, string>
            )[r.reason] ?? "利益判定の安全性を確認できません"}
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
function DecisionView({ value }: { value: unknown }) {
  if (!value || typeof value !== "object")
    return <p>判定はまだありません。市場データの取得をお待ちください。</p>;
  const d = value as Record<string, unknown>;
  return (
    <div>
      <p>取引判定：{label(d.action)}</p>
      <p>
        理由：
        <Reason code={String(d.reason ?? "STRATEGY_WAIT")} />
      </p>
      <p>判定日時：{dateTime(String(d.timestamp))}</p>
      <p>
        確信度：{percent(d.confidence as number)} ／ 損切り：
        {percent(d.stopLossPct as number)} ／ 利確：
        {percent(d.takeProfitPct as number)}
      </p>
      {d.sellPurpose != null && <p>売却目的：{label(d.sellPurpose)}</p>}
    </div>
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
    [tab, setTab] = useState("Overview"),
    [timeframe, setTimeframe] = useState<300 | 900 | 3600>(300);
  const api = useCallback(
    async (path: string, body?: unknown) => {
      const r = await fetch("/api/" + path, {
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
  async function refresh() {
    try {
      setData(await api("state"));
      setError("");
    } catch (e) {
      setError(errorCode(e));
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
              "運用検証",
              "バックテスト比較",
            ].map((t) => (
              <button
                className={tab === t ? "active" : ""}
                key={t}
                onClick={() => {
                  setTab(t);
                }}
              >
                {label(t) === "未確認" ? t : label(t)}
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
                <Reason code={error} />
                接続・管理トークンと運用状態を確認して再試行してください。
              </p>
            )}
            {data && (
              <>
                <div className="title">
                  <div>
                    <small>仮想売買の検証</small>
                    <h1>{label(tab) === "未確認" ? tab : label(tab)}</h1>
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
                {data.marketData && (
                  <MarketDataPanel
                    value={data.marketData}
                    unavailable={!!error}
                  />
                )}
                {data.runtime.emergency && (
                  <p className="error">
                    緊急停止中です。原因と接続状態を確認し、設定の「停止状態の解除」から解除後、PAPER運用を手動で開始してください。
                  </p>
                )}
                {!data.runtime.running &&
                  !data.runtime.error &&
                  !data.runtime.emergency && (
                    <p>
                      停止中です。設定で保存済みの条件を確認し、「PAPER運用開始」を押してください。
                    </p>
                  )}
                {data.runtime.error && (
                  <p className="error">
                    停止理由：
                    <Reason code={data.runtime.error} />
                    次の操作：{nextStep(data.runtime.error)}
                  </p>
                )}
                {tab === "Overview" && (
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
                    <section>
                      <h3>
                        SUI / USDC <small>5分足 · EMA20 / EMA50</small>
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
                        {label(kind) === "未確認" ? kind : label(kind)} · 確定
                        {timeframe / 60}分足
                      </h3>
                      <Chart
                        candles={data.candlesByTimeframe[timeframe]}
                        kind={kind}
                        trades={data.trades}
                      />
                    </section>
                  ))}
                {tab === "Strategy" && (
                  <>
                    <ProfitGuardPanel data={data} />
                    <section>
                      <h3>ルールベース戦略</h3>
                      <p>
                        EMA20 /
                        EMA50、RSIの閾値交差、MACD方向、出来高異常を組み合わせます。
                      </p>
                      <DecisionView value={data.decision} />
                      <h3>戦略パラメータ</h3>
                      <SettingsChanges
                        before={data.settings}
                        after={data.settings}
                        keys={
                          Object.keys(
                            data.settings,
                          ) as (keyof State["settings"])[]
                        }
                      />
                      <p>DeepSeek：未実装（拡張用インターフェースのみ）</p>
                    </section>
                  </>
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
                {tab === "バックテスト比較" && (
                  <BacktestComparison token={token} settings={data.settings} />
                )}
                {tab === "運用検証" && <OperationsPanel api={api} />}
                {tab === "Settings" && (
                  <SettingsPage
                    data={data}
                    api={api}
                    onSaved={refresh}
                    control={control}
                  />
                )}
              </>
            )}
          </main>
        </>
      )}
      <footer>
        PAPER（仮想売買）モード · 仮想売買のみ · 署名 / 取引送信なし ·
        市場データ提供：
        {data?.marketData
          ? (data.marketData.source ?? "未取得")
          : "GeckoTerminal"}
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
