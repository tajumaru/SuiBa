import React, { useEffect, useState } from "react";
import type { BotEngine } from "../../worker/src/engine.ts";
import type { DecisionTelemetry } from "../../worker/src/operations.ts";
import type { Settings } from "../../../packages/shared/src/index.ts";
import { dateTime, label, number, percent } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
import { fields, formatSettingValue, type Field } from "./SettingsPage.tsx";
import { ProfitGuardPanel } from "./ProfitGuardPanel.tsx";
import {
  STRATEGY_PARAM_GROUPS,
  appendIndicatorPoint,
  emaVizData,
  isFreshDecision,
  macdBars,
  paramScale,
  strategyConditions,
  verdictTone,
  type IndicatorPoint,
  type StrategyConditions,
  type StrategyParamDef,
} from "./strategyView.ts";

type State = ReturnType<BotEngine["snapshot"]>;

const money = (v: number | null | undefined) => number(v, 4);
const precise = (v: string | null | undefined) =>
  v == null ? "不明" : `${number(v)} USDC`;
const signed = (v: number, digits = 4) =>
  `${v > 0 ? "+" : ""}${number(v, digits)}`;
const signedPct = (ratio: number) => `${ratio > 0 ? "+" : ""}${percent(ratio)}`;

/**
 * Accumulates the short indicator history the strategy mini charts
 * draw, one point per new decision. It lives at the App level (like
 * the narration state) so switching tabs does not erase what the
 * client has actually seen; points are appended only from recorded
 * decision evidence, never synthesised.
 */
export function useIndicatorHistory(
  decision: DecisionTelemetry | null | undefined,
) {
  const [history, setHistory] = useState<IndicatorPoint[]>([]);
  useEffect(() => {
    setHistory((h) => appendIndicatorPoint(h, decision, Date.now()));
  }, [decision]);
  return history;
}

/* ------------------------------------------------------------------ */
/* Condition cards                                                     */
/* ------------------------------------------------------------------ */

const STATE_PILL = { met: "成立", unmet: "未成立", unknown: "未取得" } as const;

function CardShell({
  name,
  what,
  state,
  unknownText,
  children,
}: {
  name: string;
  what: string;
  state: "met" | "unmet" | "unknown";
  unknownText: string;
  children: React.ReactNode;
}) {
  return (
    <div className="strategy-cond" data-state={state}>
      <div className="strategy-cond-head">
        <span className="strategy-cond-name">{name}</span>
        <span className="strategy-cond-what">{what}</span>
        <span className="strategy-pill">{STATE_PILL[state]}</span>
      </div>
      {state === "unknown" ? (
        <p className="strategy-unknown">{unknownText}</p>
      ) : (
        children
      )}
    </div>
  );
}

function EmaViz({
  history,
  dec,
  now,
}: {
  history: IndicatorPoint[];
  dec: DecisionTelemetry | null;
  now: number;
}) {
  const viz = emaVizData(history, dec, now);
  if (viz.kind === "none") return null;
  const w = 200,
    h = 64,
    pad = 8;
  if (viz.kind === "levels") {
    const values = [viz.price, viz.ema20, viz.ema50],
      min = Math.min(...values),
      max = Math.max(...values),
      span = max - min || Math.max(0.01, max * 0.01),
      y = (v: number) => pad + (1 - (v - min) / span) * (h - pad * 2);
    const rows = [
      { label: "価格", value: viz.price, color: "#dbe7f3" },
      { label: "EMA20", value: viz.ema20, color: "#72d1ff" },
      { label: "EMA50", value: viz.ema50, color: "#7d93a8" },
    ];
    return (
      <>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          role="img"
          aria-label="価格とEMA20・EMA50の水準図（履歴が貯まるまでは現在の水準を表示）"
        >
          {rows.map((r) => (
            <g key={r.label}>
              <line
                x1="44"
                x2={w}
                y1={y(r.value)}
                y2={y(r.value)}
                stroke={r.color}
                strokeWidth="2"
              />
              <text x="0" y={y(r.value) + 3} fill="#91a5b6" fontSize="9">
                {r.label}
              </text>
            </g>
          ))}
        </svg>
        <p className="strategy-note">
          履歴が貯まるまでは、現在値の水準で表示しています。
        </p>
      </>
    );
  }
  const all = [...viz.ema20, ...viz.ema50],
    min = Math.min(...all),
    max = Math.max(...all),
    span = max - min || 0.01,
    x = (i: number) => (i / (viz.ema20.length - 1)) * w,
    y = (v: number) => pad + (1 - (v - min) / span) * (h - pad * 2),
    line = (set: number[]) => set.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return (
    <>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label="EMA20とEMA50の推移図（記録した判定の履歴）"
      >
        <polyline
          points={line(viz.ema50)}
          fill="none"
          stroke="#7d93a8"
          strokeWidth="2.5"
        />
        <polyline
          points={line(viz.ema20)}
          fill="none"
          stroke="#72d1ff"
          strokeWidth="2.5"
        />
      </svg>
      <div className="strategy-legend">
        <span>
          <i className="strategy-swatch ema20" />
          EMA20（短期）
        </span>
        <span>
          <i className="strategy-swatch ema50" />
          EMA50（長期）
        </span>
      </div>
    </>
  );
}

function RsiScale({
  rsi,
  previousRsi,
  oversold,
  overbought,
}: {
  rsi: number;
  previousRsi: number;
  oversold: number;
  overbought: number;
}) {
  return (
    <>
      <div
        className="strategy-rsi-scale"
        role="img"
        aria-label={`RSIの目盛り。買い基準${oversold}、売り基準${overbought}、現在${rsi}、前回${previousRsi}`}
      >
        <div
          className="strategy-rsi-track"
          style={{
            background: `linear-gradient(90deg,#2e5d50 0%,#2e5d50 ${oversold}%,#22384c ${oversold}%,#22384c ${overbought}%,#4c2f35 ${overbought}%,#4c2f35 100%)`,
          }}
        />
        <div
          className="strategy-rsi-line"
          style={{ left: `${oversold}%` }}
          data-label={`買い基準 ${oversold}`}
        />
        <div
          className="strategy-rsi-prev"
          style={{ left: `${previousRsi}%` }}
          title={`前回 ${previousRsi}`}
        />
        <div
          className="strategy-rsi-mark"
          style={{ left: `${rsi}%` }}
          data-label={`いま ${rsi}`}
        />
      </div>
      <div className="strategy-rsi-ends">
        <span>0（売られ過ぎ）</span>
        <span>100（買われ過ぎ）</span>
      </div>
    </>
  );
}

function MacdViz({ bars }: { bars: number[] }) {
  const w = 200,
    h = 64,
    midY = 32,
    max = Math.max(0.0005, ...bars.map((v) => Math.abs(v))),
    bw = 18,
    gap = 6,
    x0 = Math.max(8, (w - (bars.length * bw + (bars.length - 1) * gap)) / 2);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label="MACDヒストグラムのミニ図（記録した判定の履歴）"
    >
      <line
        x1="0"
        y1={midY}
        x2={w}
        y2={midY}
        stroke="#33506e"
        strokeWidth="1"
      />
      {bars.map((v, i) => {
        const bh = Math.max(2, Math.round((Math.abs(v) / max) * 26));
        return (
          <rect
            key={i}
            x={x0 + i * (bw + gap)}
            y={v >= 0 ? midY - bh : midY}
            width={bw}
            height={bh}
            rx="2"
            fill={v >= 0 ? "#43dfb2" : "#8fa6bb"}
          />
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Result panel                                                        */
/* ------------------------------------------------------------------ */

function ResultPanel({
  decision,
  conditions,
  price,
}: {
  decision: State["decision"];
  conditions: StrategyConditions;
  price: number | null;
}) {
  const tone = verdictTone(decision?.action);
  return (
    <aside className={`strategy-result tone-${tone}`} aria-label="いまの判定">
      <div className="strategy-result-cap">いまの判定</div>
      {decision ? (
        <>
          <div className="strategy-verdict">
            取引判定：{label(decision.action)}
          </div>
          {conditions.metCount != null && (
            <div className="strategy-dots" aria-label="成立した買い条件の数">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={
                    i < conditions.metCount!
                      ? "strategy-dot on"
                      : "strategy-dot"
                  }
                />
              ))}
              <span>買い条件 3つ中 {conditions.metCount}つ成立</span>
            </div>
          )}
          <p className="strategy-summary">
            理由：
            <Reason code={String(decision.reason ?? "STRATEGY_WAIT")} />
          </p>
          <div className="strategy-chips">
            <span className="strategy-chip">
              確信度 <b>{percent(decision.confidence)}</b>
            </span>
            <span className="strategy-chip">
              損切り{" "}
              <b>
                {typeof decision.stopLossPct === "number"
                  ? `-${percent(decision.stopLossPct)}`
                  : percent(decision.stopLossPct)}
              </b>
            </span>
            <span className="strategy-chip">
              利確{" "}
              <b>
                {typeof decision.takeProfitPct === "number"
                  ? `+${percent(decision.takeProfitPct)}`
                  : percent(decision.takeProfitPct)}
              </b>
            </span>
            {price != null && (
              <span className="strategy-chip">
                現在価格 <b>{money(price)} USDC</b>
              </span>
            )}
            <span className="strategy-chip">
              判定日時 <b>{dateTime(decision.timestamp)}</b>
            </span>
            {decision.sellPurpose != null && (
              <span className="strategy-chip">
                売却目的 <b>{label(decision.sellPurpose)}</b>
              </span>
            )}
          </div>
        </>
      ) : (
        <p className="strategy-unknown">
          判定はまだありません。市場データの取得をお待ちください。
        </p>
      )}
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Parameter groups                                                    */
/* ------------------------------------------------------------------ */

const formatRawValue = (field: Field, raw: number) =>
  `${number(Number((raw * (field.scale ?? 1)).toPrecision(12)))} ${field.unit ?? ""}`.trim();

function ParamRow({
  settings,
  def,
}: {
  settings: Settings;
  def: StrategyParamDef;
}) {
  const field = fields.find((f) => f.key === def.key);
  if (!field) return null;
  const scale = paramScale(settings, def);
  return (
    <div className="strategy-param">
      <div className="strategy-param-row">
        <span className="strategy-param-label">{field.label}</span>
        <span className="strategy-param-value">
          {formatSettingValue(settings, field)}
        </span>
      </div>
      {def.bar && (
        <>
          <div
            className="strategy-bar"
            role="img"
            aria-label={`選べる範囲は${formatRawValue(field, scale.domainMin)}から${formatRawValue(field, scale.domainMax)}、現在の値は${formatSettingValue(settings, field)}`}
          >
            <div
              className="strategy-bar-range"
              style={{
                left: `${scale.bandLeft * 100}%`,
                width: `${scale.bandWidth * 100}%`,
              }}
            />
            <div
              className="strategy-bar-mark"
              style={{ left: `${scale.marker * 100}%` }}
            />
          </div>
          <div className="strategy-bar-ends">
            <span>{formatRawValue(field, scale.domainMin)}</span>
            <span>{formatRawValue(field, scale.domainMax)}</span>
          </div>
        </>
      )}
      <p className="strategy-param-help">{field.help}</p>
    </div>
  );
}

/**
 * Compact profit-guard status card: the same recorded report the
 * full panel reads (data.profitGuard), summarised. The full panel
 * stays one tap away in the disclosure below — nothing is dropped.
 */
function ProfitGuardStatus({ data }: { data: State }) {
  const r = data.profitGuard;
  if (!r)
    return (
      <p className="strategy-pg-note">
        利益判定データはまだありません。原価や見積もりを取得できない利益目的の注文は拒否します。
      </p>
    );
  const stale = r.validUntil != null && Date.now() >= r.validUntil,
    verdict = r.reason.startsWith("PROTECTIVE_EXIT")
      ? "損切り・リスク削減優先"
      : r.reason === "QUOTE_UNAVAILABLE"
        ? "見積もり取得失敗"
        : r.netProfitUsdc === null
          ? "計算不能"
          : r.allowed
            ? "利確可能（試算）"
            : "利益不足・見送り";
  return (
    <div className="strategy-pg-try">
      {r.scope === "BUY_SCENARIO" && r.acquisitionUnitPrice != null && (
        <div className="strategy-pg-row">
          <span>費用込み想定取得単価</span>
          <b>{number(r.acquisitionUnitPrice)} USDC / SUI</b>
        </div>
      )}
      <div className="strategy-pg-row">
        <span>モデル損益分岐価格</span>
        <b>
          {r.breakEvenPrice ? `${number(r.breakEvenPrice)} USDC / SUI` : "不明"}
        </b>
      </div>
      {r.scope === "BUY_SCENARIO" && r.targetPrice != null && (
        <div className="strategy-pg-row">
          <span>想定利確価格</span>
          <b>{number(r.targetPrice)} USDC</b>
        </div>
      )}
      {r.scope !== "BUY_SCENARIO" && (
        <div className="strategy-pg-row">
          <span>現在の保有分の取得原価</span>
          <b>
            {precise(
              data.acquisitionCostUsdc ?? String(data.portfolio.costBasis),
            )}
          </b>
        </div>
      )}
      <div className="strategy-pg-row">
        <span>
          {r.scope === "BUY_SCENARIO"
            ? "購入前の想定利確時純利益"
            : "最新売却見積もりの予想純利益"}
        </span>
        <b>{precise(r.netProfitUsdc)}</b>
      </div>
      <div className="strategy-pg-row">
        <span>判定</span>
        <b className={r.allowed ? "strategy-pg-good" : undefined}>{verdict}</b>
      </div>
      <p className="strategy-pg-note">
        {stale
          ? "見積もりの有効期限が切れています（実行には再見積もりが必要）。"
          : "取得時点の推定です。"}
        利益条件の通過は、実約定を意味しません。
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The strategy tab                                                    */
/* ------------------------------------------------------------------ */

export function StrategyPanel({
  data,
  telemetry,
  history,
}: {
  data: State;
  telemetry: DecisionTelemetry | null;
  history: IndicatorPoint[];
}) {
  const now = Date.now(),
    fresh = isFreshDecision(telemetry, now),
    dec = fresh ? telemetry : null,
    conditions = strategyConditions(
      telemetry,
      data.settings.maxVolumeChange,
      now,
    ),
    unknownText =
      telemetry == null
        ? "判断根拠データがまだありません。"
        : "判断根拠が古いため、状態を表示していません。",
    bars = macdBars(history, telemetry, now);
  return (
    <>
      <section>
        <h3>ルールベース戦略 — どう判定するか</h3>
        <p className="strategy-lead">
          3つの条件がすべて揃い、出来高に異常がなければ「買い」。1つでも欠ければ見送ります。下の図は、最新の判断根拠そのものです。
        </p>
        <div className="strategy-flow">
          <div className="strategy-conds">
            <div className="strategy-cond-row">
              <CardShell
                name="EMA"
                what="流れの向き"
                state={conditions.ema.state}
                unknownText={unknownText}
              >
                <div className="strategy-viz">
                  <EmaViz history={history} dec={dec} now={now} />
                </div>
                <p className="strategy-now">
                  EMA20 <b>{money(conditions.ema.ema20)}</b> ／ EMA50{" "}
                  <b>{money(conditions.ema.ema50)}</b>
                </p>
                <p className="strategy-note">
                  差 <b>{signedPct(conditions.ema.gapPct!)}</b>
                  。短期が長期より上なら上向きの流れ。
                </p>
              </CardShell>
              <CardShell
                name="RSI"
                what="売られ過ぎからの回復"
                state={conditions.rsi.state}
                unknownText={unknownText}
              >
                <div className="strategy-viz">
                  <RsiScale
                    rsi={conditions.rsi.rsi!}
                    previousRsi={conditions.rsi.previousRsi!}
                    oversold={conditions.rsi.oversold!}
                    overbought={conditions.rsi.overbought!}
                  />
                </div>
                <p className="strategy-now">
                  現在 <b>{number(conditions.rsi.rsi, 1)}</b>（前回{" "}
                  {number(conditions.rsi.previousRsi, 1)}）
                </p>
                <p className="strategy-note">
                  買い基準{conditions.rsi.oversold}
                  を下回った後、そこから上へ戻れば回復として成立。
                </p>
              </CardShell>
              <CardShell
                name="MACD"
                what="勢いの方向"
                state={conditions.macd.state}
                unknownText={unknownText}
              >
                <div className="strategy-viz">
                  <MacdViz bars={bars} />
                </div>
                <p className="strategy-now">
                  ヒストグラム <b>{signed(conditions.macd.histogram!)}</b>
                </p>
                <p className="strategy-note">
                  前回 {signed(conditions.macd.previousHistogram!)} → 現在{" "}
                  {signed(conditions.macd.histogram!)}
                  。前回より上向いていれば成立。
                </p>
              </CardShell>
            </div>
            <div className="strategy-vol" data-state={conditions.volume.state}>
              <span className="strategy-vol-name">出来高チェック</span>
              {conditions.volume.state === "unknown" ? (
                <span className="strategy-vol-val">{unknownText}</span>
              ) : (
                <>
                  <span className="strategy-vol-val">
                    現在の変化 <b>{number(conditions.volume.multiple, 2)}倍</b>{" "}
                    ／ 上限 <b>{number(conditions.volume.limit)}倍</b>
                  </span>
                  <span
                    className={
                      conditions.volume.state === "exceeded"
                        ? "strategy-vol-ng"
                        : "strategy-vol-ok"
                    }
                  >
                    {conditions.volume.state === "exceeded"
                      ? "✗ 異常（上限超過・見送り対象）"
                      : "✓ 正常（異常なし）"}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="strategy-arrow" aria-hidden="true">
            →
          </div>
          <ResultPanel
            decision={data.decision}
            conditions={conditions}
            price={dec ? dec.price : data.price}
          />
        </div>
      </section>
      <h3 className="strategy-params-title">戦略パラメータ</h3>
      <p className="strategy-lead">
        このページ下部の「かんたん設定」で変更できる値です。バーの印が現在の値、薄い帯が選べる範囲を表します。
      </p>
      <div className="strategy-groups">
        {STRATEGY_PARAM_GROUPS.map((group) => (
          <section
            key={group.id}
            className="strategy-group"
            aria-label={`${group.title}グループ`}
          >
            <div className="strategy-group-head">
              <h4>{group.title}</h4>
              {group.id === "profit-guard" && (
                <span
                  className={
                    data.settings.profitGuardEnabled
                      ? "strategy-pg-on"
                      : "strategy-pg-off"
                  }
                >
                  {data.settings.profitGuardEnabled ? "有効" : "無効"}
                </span>
              )}
            </div>
            <p className="strategy-group-desc">{group.description}</p>
            {group.id === "profit-guard" && <ProfitGuardStatus data={data} />}
            {group.params.map((def) => (
              <ParamRow key={def.key} settings={data.settings} def={def} />
            ))}
            {group.id === "profit-guard" && (
              <details className="strategy-pg-details">
                <summary>利益保護の詳細（コスト内訳・見積もり）</summary>
                <ProfitGuardPanel data={data} />
              </details>
            )}
          </section>
        ))}
      </div>
      <p className="strategy-foot">
        DeepSeek：未実装（拡張用インターフェースのみ）
      </p>
    </>
  );
}
