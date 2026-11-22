import React from "react";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import type { DecisionTelemetry } from "../../worker/src/operations.ts";
import type { Settings } from "../../../packages/shared/src/index.ts";
import { fixed4, label, number, percent } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
import { fields, formatSettingValue, type Field } from "./SettingsPage.tsx";
import { ProfitGuardPanel } from "./ProfitGuardPanel.tsx";
export { useIndicatorHistory } from "./indicatorHistory.ts";
import {
  STRATEGY_PARAM_GROUPS,
  isFreshDecision,
  paramScale,
  strategyConditions,
  verdictTone,
  type StrategyConditions,
  type StrategyParamDef,
} from "./strategyView.ts";

type State = BotSnapshot;

const money = (v: number | null | undefined) => number(v, 4);
/** Four-decimal rendering (presentation.fixed4) for the compact
    summary block below; the full panel keeps full precision. */
const precise4 = (v: string | null | undefined) =>
  v == null ? "不明" : `${fixed4(v)} USDC`;
const signedPct = (ratio: number) => `${ratio > 0 ? "+" : ""}${percent(ratio)}`;



/* ------------------------------------------------------------------ */
/* Condition cards                                                     */
/* ------------------------------------------------------------------ */

const STATE_PILL = { met: "成立", unmet: "未成立", unknown: "未取得" } as const;

function CondRow({
  name,
  what,
  state,
  pillText,
  unknownText,
  children,
}: {
  name: string;
  what: string;
  state: string;
  pillText?: string;
  unknownText: string;
  children: React.ReactNode;
}) {
  return (
    <div className="strategy-row" data-state={state}>
      <div className="strategy-row-name">
        <span className="strategy-cond-name">{name}</span>
        <span className="strategy-cond-what">{what}</span>
      </div>
      {state === "unknown" ? (
        <span className="strategy-row-unknown">{unknownText}</span>
      ) : (
        <span className="strategy-row-fig">{children}</span>
      )}
      <span className="strategy-pill">
        {pillText ?? STATE_PILL[state as keyof typeof STATE_PILL]}
      </span>
    </div>
  );
}

/** Judgment time as HH:MM (JST) for the slim result card's meta line. */
const timeOfDay = (value: string | number) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date);
};

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
  const reasonCode = decision
    ? String(decision.reason ?? "STRATEGY_WAIT")
    : null;
  // The plain "conditions not met" reason repeats what the dots already
  // say, so the reason line appears only when it carries real information
  // (a ProfitGuard block, a held position, a cooldown, …).
  const plainReason =
    reasonCode === "STRATEGY_WAIT" || decision?.reason === "条件未成立";
  // The buy-condition dots matter only while waiting on them: a BUY
  // verdict already implies all three, and they say nothing about a SELL.
  const showDots = decision?.action === "WAIT" && conditions.metCount != null;
  const judgedAt = decision ? timeOfDay(decision.timestamp) : null;
  return (
    <aside className={`strategy-result tone-${tone}`} aria-label="いまの判定">
      <div className="strategy-result-cap">いまの判定</div>
      {decision ? (
        <>
          <div className="strategy-verdict-row">
            <div className="strategy-verdict">{label(decision.action)}</div>
            {showDots && (
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
                <span>
                  {conditions.metCount! >= 3
                    ? "3つ成立"
                    : `あと${3 - conditions.metCount!}つ`}
                </span>
              </div>
            )}
          </div>
          {!plainReason && (
            <p className="strategy-summary">
              理由：
              <Reason code={reasonCode!} />
            </p>
          )}
          <div className="strategy-meta">
            {price != null && <span>{money(price)} USDC</span>}
            {price != null && judgedAt && <span aria-hidden="true">・</span>}
            {judgedAt && <span>{judgedAt} 時点</span>}
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
          <b>{fixed4(r.acquisitionUnitPrice)} USDC / 基軸通貨</b>
        </div>
      )}
      <div className="strategy-pg-row">
        <span>モデル損益分岐価格</span>
        <b>
          {r.breakEvenPrice
            ? `${fixed4(r.breakEvenPrice)} USDC / 基軸通貨`
            : "不明"}
        </b>
      </div>
      {r.scope === "BUY_SCENARIO" && r.targetPrice != null && (
        <div className="strategy-pg-row">
          <span>想定利確価格</span>
          <b>{fixed4(r.targetPrice)} USDC</b>
        </div>
      )}
      {r.scope !== "BUY_SCENARIO" && (
        <div className="strategy-pg-row">
          <span>現在の保有分の取得原価</span>
          <b>
            {precise4(
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
        <b>{precise4(r.netProfitUsdc)}</b>
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
}: {
  data: State;
  telemetry: DecisionTelemetry | null;
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
        : "判断根拠が古いため、状態を表示していません。";
  return (
    <>
      {/* With no fresh telemetry every condition is unknown and the
          verdict is not a judgement at all, so the whole flow is
          hidden; the parameter groups below still carry information. */}
      {conditions.metCount !== null && (
      <section>
        <h3>さくせん</h3>
        <div className="strategy-flow">
          <ResultPanel
            decision={data.decision}
            conditions={conditions}
            price={dec ? dec.price : data.price}
          />
          <div className="strategy-rows">
            <CondRow
              name="EMA"
              what="価格の向き"
              state={conditions.ema.state}
              unknownText={unknownText}
            >
              差 <b>{signedPct(conditions.ema.gapPct!)}</b>
              {conditions.ema.viaShrink && <small>（縮小中）</small>}
            </CondRow>
            <CondRow
              name="RSI"
              what="売られ過ぎからの回復"
              state={conditions.rsi.state}
              unknownText={unknownText}
            >
              <b>{number(conditions.rsi.rsi, 1)}</b>
              <small> ／ 基準 {conditions.rsi.oversold}</small>
            </CondRow>
            <CondRow
              name="MACD"
              what="勢いの方向"
              state={conditions.macd.state}
              unknownText={unknownText}
            >
              <b>
                {conditions.macd.histogram! > conditions.macd.previousHistogram!
                  ? "上向き"
                  : conditions.macd.histogram! <
                      conditions.macd.previousHistogram!
                    ? "下向き"
                    : "変わらず"}
              </b>
            </CondRow>
            <CondRow
              name="出来高"
              what="チェック"
              state={conditions.volume.state}
              pillText={
                conditions.volume.state === "exceeded"
                  ? "異常"
                  : conditions.volume.state === "ok"
                    ? "正常"
                    : undefined
              }
              unknownText={unknownText}
            >
              <b>{number(conditions.volume.multiple, 2)}倍</b>
              <small> ／ 上限 {number(conditions.volume.limit)}倍</small>
            </CondRow>
          </div>
        </div>
      </section>
      )}
      <h3 className="strategy-params-title">戦略パラメータ</h3>
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
                <summary>ProfitGuardの詳細（コスト内訳・見積もり）</summary>
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
