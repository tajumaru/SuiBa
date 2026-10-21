import React from "react";
import { dateTime, number, label, reason, errorCode } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
import { useEffect, useState } from "react";
import type { Settings } from "../../../packages/shared/src/index.ts";
import type {
  ComparisonInput,
  ComparisonResult,
  RunResult,
} from "../../../packages/backtest-engine/src/index.ts";

const format = number;
// datetime-local represents Japan time; API epochs remain unchanged.
const date = (s: number) =>
  new Date(s * 1000 + 9 * 3600000).toISOString().slice(0, 16);
const epoch = (s: string) => Math.floor(Date.parse(s + ":00+09:00") / 1000);
const errors: Record<string, string> = {
  INSUFFICIENT_HISTORY_63_CANDLES:
    "保存済み確定足が不足しています。最低63本が必要です。",
  INSUFFICIENT_WARMUP_61_CANDLES:
    "検証開始前に61本以上の連続した確定足が必要です。",
  PERIOD_OUTSIDE_SAVED_HISTORY:
    "指定期間が保存済みデータ外、または検証足が2本未満です。",
  CANDLE_GAP:
    "保存済みデータに欠損または重複があります。連続した期間を選んでください。",
  INVALID_CANDLE: "不正な価格・出来高・タイムスタンプが含まれています。",
  PRICE_OUTLIER:
    "異常な価格変化を検出しました。データソースを確認してください。",
  INVALID_BACKTEST_OPTIONS: "期間の重複・設定値・安全上限を確認してください。",
  BACKTEST_BUSY: "比較を実行中です。完了後に再試行してください。",
};
function Lines({
  result,
  drawdown = false,
}: {
  result: ComparisonResult;
  drawdown?: boolean;
}) {
  const values = [result.off, result.on].map((r) => [
    drawdown ? 0 : result.options.initialUsdc,
    ...r.curve.map((p) => (drawdown ? p.drawdown * 100 : p.equity)),
  ]);
  const all = values.flat(),
    min = drawdown ? 0 : Math.min(...all, result.options.initialUsdc),
    max = Math.max(...all, drawdown ? 1 : result.options.initialUsdc),
    span = max - min || 1;
  return (
    <svg
      viewBox="0 0 1000 220"
      role="img"
      aria-label={
        drawdown
          ? "利益保護の有効・無効別の最大下落率比較"
          : "利益保護の有効・無効別の資産推移比較"
      }
    >
      <text x="10" y="18" fill="#8fa7b9" fontSize="12">
        {format(max)} {drawdown ? "%" : "USDC"}
      </text>
      {values.map((v, k) => (
        <polyline
          key={k}
          fill="none"
          stroke={k ? "#43dfb2" : "#70b9ff"}
          strokeWidth="2"
          points={v
            .map(
              (y, i) =>
                `${20 + (i * 960) / Math.max(v.length - 1, 1)},${195 - ((y - min) / span) * 165}`,
            )
            .join(" ")}
        />
      ))}
      <text x="10" y="216" fill="#8fa7b9" fontSize="12">
        {format(min)} {drawdown ? "%" : "USDC"} · 左：検証開始 / 右：検証終了
      </text>
    </svg>
  );
}
function Points({ result }: { result: ComparisonResult }) {
  const bars = result.candles,
    min = Math.min(...bars.map((b) => b.low)),
    max = Math.max(...bars.map((b) => b.high)),
    span = max - min || 1;
  const x = (t: number) =>
    25 +
    ((t / 1000 - bars[0].timestamp) /
      (bars.at(-1)!.timestamp - bars[0].timestamp || 1)) *
      950;
  const y = (p: number) => 190 - ((p - min) / span) * 160;
  return (
    <svg
      viewBox="0 0 1000 220"
      role="img"
      aria-label="価格と買い・売り・利益保護による見送り地点"
    >
      <polyline
        fill="none"
        stroke="#8fa7b9"
        points={bars
          .map((b) => `${x(b.timestamp * 1000)},${y(b.close)}`)
          .join(" ")}
      />
      {[result.off, result.on].flatMap((run, k) =>
        run.events
          .filter(
            (e) =>
              e.trade || (e.status === "WAIT" && e.profit && !e.profit.allowed),
          )
          .map((e) => (
            <text
              key={`${k}:${e.timestamp}`}
              x={x(e.timestamp) + (k ? 3 : -3)}
              y={y(
                e.quote?.referencePrice ??
                  bars.find((b) => b.timestamp * 1000 === e.timestamp)?.open ??
                  min,
              )}
              fontSize="12"
              fill={k ? "#43dfb2" : "#70b9ff"}
            >
              <title>
                {k ? "利益保護あり" : "利益保護なし"} · {dateTime(e.timestamp)}{" "}
                · {e.reasons.map(reason).join("、")}
              </title>
              {e.trade ? (e.trade.side === "BUY" ? "▲" : "▼") : "W"}
            </text>
          )),
      )}
      <text x="10" y="216" fill="#8fa7b9" fontSize="12">
        ▲ 買い · ▼ 売り · W 利益不足による見送り（ポインターで理由）
      </text>
    </svg>
  );
}
export function BacktestComparison({
  token,
  settings,
}: {
  token: string;
  settings: Settings;
}) {
  const [input, setInput] = useState<ComparisonInput>({
    start: 0,
    end: 1,
    trainEnd: 0,
    initialUsdc: 100,
    maxOrder: settings.maxOrder,
    slippage: settings.maxSlippage,
    spread: 0.001,
    impact: 0.001,
    dexFeeRate: 0.003,
    additionalFeeRate: 0,
    gasUsdc: settings.gasUsdc,
    participation: 0.001,
    minNetProfitUsdc: settings.minNetProfitUsdc,
    minNetProfitPct: settings.minNetProfitPct,
  });
  const [result, setResult] = useState<ComparisonResult | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [available, setAvailable] = useState("読み込み中"),
    [mode, setMode] = useState<"on" | "off">("on"),
    [showAll, setShowAll] = useState(false);
  async function request(body?: ComparisonInput) {
    const r = await fetch("/api/backtest", {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "BACKTEST_FAILED");
    return data;
  }
  useEffect(() => {
    let active = true;
    void request()
      .then((m) => {
        if (!active) return;
        if (m.count < 63) {
          setAvailable(
            `保存済み${m.count}本。検証と61本のウォームアップ用に追加データが必要です。`,
          );
          return;
        }
        const tf = m.timeframe ?? 300,
          split = Math.max(61, Math.floor(m.count * 0.6));
        setAvailable(
          `${m.count}本 · ${m.source} · ${dateTime(m.first * 1000)} ～ ${dateTime(m.last * 1000)}`,
        );
        setInput((i) => ({
          ...i,
          start: m.first + split * tf,
          trainEnd: m.first + (split - 1) * tf,
          end: m.last,
        }));
        if (m.latest?.version === 2) {
          setResult(m.latest);
          setInput(m.latest.options);
        }
      })
      .catch((e) => {
        if (active) setError(errorCode(e));
      });
    return () => {
      active = false;
    };
  }, [token]);
  const fields: [keyof ComparisonInput, string, number, number, number][] = [
    ["initialUsdc", "初期USDC", 0.01, 1000000, 0.01],
    ["maxOrder", "注文上限 USDC", 0.01, 5, 0.01],
    ["slippage", "価格ずれの上限（%）", 0, 0.003, 0.0001],
    ["spread", "売値と買値の差の控除率（%）", 0, 0.01, 0.0001],
    ["impact", "取引による価格への影響（%）", 0, 0.003, 0.0001],
    ["dexFeeRate", "DEX内包手数料率（%）", 0, 0.01, 0.0001],
    ["additionalFeeRate", "追加手数料率（内包分と別）（%）", 0, 0.01, 0.0001],
    ["gasUsdc", "1約定のガス USDC", 0.000001, 1, 0.000001],
    [
      "participation",
      "直前出来高への参加率上限（%）",
      0.000001,
      0.01,
      0.000001,
    ],
    ["minNetProfitUsdc", "最低純利益 USDC", 0, 5, 0.000001],
    ["minNetProfitPct", "最低利益率（%）", 0, 1, 0.001],
  ];
  const ratioKeys = new Set([
    "slippage",
    "spread",
    "impact",
    "dexFeeRate",
    "additionalFeeRate",
    "participation",
    "minNetProfitPct",
  ]);
  const summaryFields: [keyof RunResult["summary"], string, number?][] = [
    ["initialEquity", "初期資産 USDC"],
    ["finalEquity", "最終資産 USDC"],
    ["netProfitUsdc", "純損益 USDC"],
    ["totalReturnPct", "リターン %"],
    ["maxDrawdown", "最大ドローダウン %", 100],
    ["tradeCount", "約定回数"],
    ["buyCount", "買い回数"],
    ["sellCount", "売り回数"],
    ["winRate", "勝率 %", 100],
    ["averageProfit", "平均利益 USDC"],
    ["averageLoss", "平均損失 USDC"],
    ["profitFactor", "利益と損失の比率"],
    ["totalFees", "総手数料 USDC（内包DEX＋追加）"],
    ["dexFees", "内包DEX手数料 USDC"],
    ["additionalFees", "追加手数料 USDC"],
    ["totalGas", "総ガス USDC"],
    ["profitWaitCount", "利益不足による見送り回数"],
    ["safetyRejectCount", "安全性・リスク制限による拒否回数"],
    ["maxLosingStreak", "最大連敗数"],
    ["realizedPnl", "実現損益 USDC"],
    ["unrealizedPnl", "未実現損益 USDC"],
  ];
  return (
    <>
      <section>
        <h3>バックテスト比較 · PAPER（仮想売買）専用</h3>
        <p>{available}</p>
        <p>
          過去価格・出来高データ（OHLCV）から生成する仮想DEX見積もりです。Cetus・DeepBookの過去の実約定価格を再現しません。利益保護の有効／無効は同じ相場・費用・次足始値条件で独立して計算します。
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              setResult(await request(input));
            } catch (e) {
              setError(errorCode(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="cards">
            {(
              [
                ["trainEnd", "学習・調整期間の最終足（日本時間）"],
                ["start", "未使用の検証期間 開始（日本時間）"],
                ["end", "検証期間の最終足（日本時間）"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  required
                  type="datetime-local"
                  value={date(input[key])}
                  onChange={(e) => {
                    if (e.target.value)
                      setInput({ ...input, [key]: epoch(e.target.value) });
                  }}
                />
              </label>
            ))}
          </div>
          <small>
            学習期間の終了足 &lt;
            検証開始足。自動最適化は行いません。既に設定調整へ使用した検証期間は未使用として扱わないでください。
          </small>
          <div className="cards">
            {fields.map(([key, label, min, max, step]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  required
                  min={min * (ratioKeys.has(key) ? 100 : 1)}
                  max={max * (ratioKeys.has(key) ? 100 : 1)}
                  step={step * (ratioKeys.has(key) ? 100 : 1)}
                  value={
                    input[key] == null
                      ? ""
                      : Number(
                          (
                            input[key]! * (ratioKeys.has(key) ? 100 : 1)
                          ).toPrecision(12),
                        )
                  }
                  onChange={(e) =>
                    setInput({
                      ...input,
                      [key]:
                        Number(e.target.value) / (ratioKeys.has(key) ? 100 : 1),
                    })
                  }
                />
              </label>
            ))}
          </div>
          <button disabled={busy}>
            {busy ? "比較を計算中…" : "同じ条件で利益保護の有効／無効を比較"}
          </button>
        </form>
        {error && (
          <p className="error" role="alert">
            {errors[error] ??
              "比較データを取得・計算できません。接続・認証・入力期間を確認して再試行してください。"}
            <small>コード：{error}</small>
          </p>
        )}
      </section>
      {result && (
        <>
          <section>
            <h3>比較結果 · 利益保護なしは青 / 利益保護ありは緑</h3>
            <p>検証モデル：過去の確定足と設定した費用に基づく仮想売買</p>
            <details>
              <summary>モデルの技術情報</summary>
              {result.model}
            </details>
            <details>
              <summary>使用データ・費用・戦略設定（技術情報）</summary>
              <pre>
                {JSON.stringify(
                  {
                    dataset: result.dataset,
                    options: result.options,
                    settings: result.settings,
                    split: result.split,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <p>
              入力期間：{dateTime(result.options.start * 1000)} ～{" "}
              {dateTime(result.options.end * 1000)}
              。フォーム変更は再実行するまで結果へ反映されません。
            </p>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>指標</th>
                    <th>利益保護なし</th>
                    <th>利益保護あり</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryFields.map(([key, label, multiplier = 1]) => (
                    <tr key={key}>
                      <td>{label}</td>
                      {[result.off, result.on].map((r, i) => (
                        <td key={i}>
                          {format(
                            typeof r.summary[key] === "number"
                              ? (r.summary[key] as number) * multiplier
                              : null,
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <small>
              部分売却ごとに按分原価を用いた損益を1回として集計します。ゼロ損益は勝率の分母に含み、連敗をリセット。損失ゼロの利益と損失の比率と該当取引なしの平均値は「—」。最終保有分は時価評価し強制決済しません。DEX手数料は受取数量へ内包済みで、損益から再控除しません。
            </small>
          </section>
          <section>
            <h3>資産推移（USDC）</h3>
            <Lines result={result} />
          </section>
          <section>
            <h3>ドローダウン推移（%）</h3>
            <Lines result={result} drawdown />
          </section>
          <section>
            <h3>価格・売買・見送り地点</h3>
            <Points result={result} />
          </section>
          <section>
            <h3>取引・判断履歴</h3>
            <select
              aria-label="履歴のモード"
              value={mode}
              onChange={(e) => setMode(e.target.value as "on" | "off")}
            >
              <option value="on">利益保護あり</option>
              <option value="off">利益保護なし</option>
            </select>
            <p>
              シグナルは前足の確定後、約定候補は次足始値です。すべての見送り・拒否を含みます。
            </p>
            <label>
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />{" "}
              通常の戦略による見送りも表示（全{result[mode].events.length}件）
            </label>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>取引時点 / シグナル足（日本時間）</th>
                    <th>判断 / 状態</th>
                    <th>数量 SUI / 価格</th>
                    <th>取得原価 USDC</th>
                    <th>純損益 実績 / 予想</th>
                    <th>DEX内包 / 追加 / ガス USDC</th>
                    <th>理由</th>
                  </tr>
                </thead>
                <tbody>
                  {result[mode].events
                    .filter((e) => showAll || e.decision.action !== "WAIT")
                    .map((e) => (
                      <tr key={e.timestamp}>
                        <td>
                          {dateTime(e.timestamp)}
                          <br />
                          {dateTime(e.signalTimestamp)}
                        </td>
                        <td>
                          {label(e.decision.action)} / {label(e.status)}
                          <br />
                          {e.decision.sellPurpose
                            ? label(e.decision.sellPurpose)
                            : "—"}
                        </td>
                        <td>
                          {e.trade
                            ? `${format(e.trade.quantity)} / ${format(e.trade.price)}`
                            : "—"}
                        </td>
                        <td>
                          {format(
                            e.trade?.acquisition?.totalCostUsdc ??
                              e.profit?.allocatedCostUsdc,
                          )}
                        </td>
                        <td>
                          {format(e.trade?.realizedProfitUsdc)} /{" "}
                          {format(e.profit?.netProfitUsdc)}
                        </td>
                        <td>
                          {format(e.quote?.dexFeeUsdc)} /{" "}
                          {(
                            e.trade?.costs ??
                            (e.decision.action === "BUY"
                              ? e.profit?.buyCosts
                              : e.profit?.costs)
                          )?.additionalFeeUsdc ?? "—"}{" "}
                          /{" "}
                          {(
                            e.trade?.costs ??
                            (e.decision.action === "BUY"
                              ? e.profit?.buyCosts
                              : e.profit?.costs)
                          )?.gasUsdc ?? "—"}
                        </td>
                        <td>
                          {e.reasons.map((code, i) => (
                            <p key={i}>
                              <Reason code={code} />
                            </p>
                          ))}
                          <br />
                          <Reason code={e.decision.reason} />
                          <details>
                            <summary>計算根拠・見積もり</summary>
                            <pre>
                              {JSON.stringify(
                                {
                                  quote: e.quote,
                                  profit: e.profit,
                                  trade: e.trade,
                                },
                                null,
                                2,
                              )}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
          <p>
            モデルの結果は将来の利益を保証しません。薄い流動性・MEV・ルート変更・遅延・ガス変動は完全には再現できません。
          </p>
        </>
      )}
    </>
  );
}
