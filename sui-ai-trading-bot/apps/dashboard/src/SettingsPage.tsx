import React, { useEffect, useReducer, useRef, useState } from "react";
import {
  defaults,
  settingsSchema,
  type Settings,
} from "../../../packages/shared/src/index.ts";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import {
  presetName,
  saveSettings,
  type SettingsApi,
} from "./settingsPresets.ts";
import {
  createEditor,
  defaultDifferentKeys,
  settingsEditor,
  sameSettings,
  type Mode,
} from "./settingsEditor.ts";
import { number, errorCode, reason } from "./presentation.ts";
import partySageIcon from "./assets/party-sage.webp";
import {
  isStartRecoveryWait,
  startRejectionReason,
} from "./operationLabels.ts";
import { OperationIcon } from "./operationIcons.tsx";
import { stopSettingAdvice } from "./stopSettingAdvice.ts";
type State = BotSnapshot;
export type Field = {
  key: keyof Settings;
  label: string;
  help: string;
  unit?: string;
  scale?: number;
};
export const fields: Field[] = [
  {
    key: "maxOrder",
    label: "1回の最大取引額",
    unit: "USDC",
    help: "1注文で使える金額の上限。最大10 USDC。",
  },
  {
    key: "dailyBuyLimit",
    label: "1日の購入上限",
    unit: "USDC",
    help: "日本時間09:00（UTC 00:00）からの累計購入額。最大20 USDC。",
  },
  {
    key: "dailyLossPct",
    label: "日次損失上限",
    unit: "%",
    scale: 100,
    help: "1日の損失がこの割合に達すると購入を制限。最大1%。",
  },
  {
    key: "maxSlippage",
    label: "価格ずれの上限",
    unit: "%",
    scale: 100,
    help: "スリッページ：見積価格とのずれ。最大0.3%。",
  },
  {
    key: "maxHoldingRatio",
    label: "基軸通貨の最大保有比率",
    unit: "%",
    scale: 100,
    help: "仮想総資産に占める基軸通貨の割合。最大20%。",
  },
  {
    key: "intervalMs",
    label: "確認間隔",
    unit: "秒",
    scale: 0.001,
    help: "市場を確認する間隔。30〜3600秒。",
  },
  {
    key: "oversold",
    label: "RSIの買い基準",
    help: "RSIは買われ過ぎ・売られ過ぎの指標。10〜45。",
  },
  {
    key: "overbought",
    label: "RSIの売り基準",
    help: "RSIがこの水準を超える動きを確認。55〜90。",
  },
  {
    key: "stopLossPct",
    label: "損切りの目安",
    unit: "%",
    scale: 100,
    help: "取得価格からの下落割合。最大10%。",
  },
  {
    key: "takeProfitPct",
    label: "利確の目安",
    unit: "%",
    scale: 100,
    help: "取得価格からの上昇割合。最大30%。ProfitGuardも確認します。",
  },
  {
    key: "maxVolumeChange",
    label: "出来高変化の上限",
    unit: "倍",
    help: "取引量の急変を検出する基準。最大20倍。",
  },
  {
    key: "feeRate",
    label: "PAPER手数料率",
    unit: "%",
    scale: 100,
    help: "仮想約定の追加手数料モデル。最大1%。",
  },
  {
    key: "gasUsdc",
    label: "PAPERガス代",
    unit: "USDC",
    help: "仮想約定ごとのネットワーク費用モデル。最大1 USDC。",
  },
  {
    key: "minNetProfitUsdc",
    label: "最低純利益",
    unit: "USDC",
    help: "手数料などを引いた後に必要な利益。0〜5 USDC。",
  },
  {
    key: "minNetProfitPct",
    label: "最低利益率",
    unit: "%",
    scale: 100,
    help: "費用控除後に必要な利益率。最大100%。",
  },
  {
    key: "emaGapShrinkCandles",
    label: "縮小とみなす連続本数",
    unit: "本",
    help: "EMA20とEMA50の差が何本連続で縮めば「縮小中」とみなすか。2〜10本。「EMAの差が縮小中も成立にする」が有効な時だけ使います。",
  },
];
export const formatSettingValue = (s: Settings, f: Field) =>
  typeof s[f.key] === "number"
    ? `${number(Number((Number(s[f.key]) * (f.scale ?? 1)).toPrecision(12)))} ${f.unit ?? ""}`
    : String(s[f.key]);
const modeCopy: Record<Mode, { label: string; blurb: string; facts: string }> = {
  safe: {
    label: "イージー",
    blurb: "安全重視・小さな金額で検証",
    facts: "注文最大 2 USDC／日次買い 10／最低純利益 1.5%／ProfitGuard あり",
  },
  hard: {
    label: "ハード",
    blurb: "よく売買する・荒い",
    facts: "注文最大 5 USDC／日次買い 20／最低純利益 0.5%／利確 1.5%・損切り 1%",
  },
  custom: {
    label: "マニュアル",
    blurb: "自分で設定を調整",
    facts: "下の詳細設定の値がそのまま効く",
  },
};
export function PresetSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: Mode) => void;
}) {
  return (
    <div className="preset-cards" role="group" aria-label="運用スタイル">
      {(["safe", "hard", "custom"] as const).map((v) => (
        <button
          type="button"
          key={v}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
          <span className="preset-row-head">
            <strong>{modeCopy[v].label}</strong>
            <small>{modeCopy[v].blurb}</small>
            {value === v && <span className="preset-selected">選択中</span>}
          </span>
          <span className="preset-facts">{modeCopy[v].facts}</span>
        </button>
      ))}
    </div>
  );
}
function Inputs({
  saved,
  draft,
  setDraft,
  items,
}: {
  saved: Settings;
  draft: Settings;
  setDraft: (s: Settings) => void;
  items: Field[];
}) {
  const different = new Set(defaultDifferentKeys(saved));
  return (
    <div className="settings-grid">
      {items.map((f) => {
        const differs = different.has(f.key);
        return (
          <div className="settings-field" key={f.key}>
            <div className="settings-field-label">
              <label htmlFor={`setting-${f.key}`}>
                {f.label} {f.unit && `(${f.unit})`}
              </label>
              {differs && (
                <span className="settings-default-diff">
                  既定と異なる（既定: {formatSettingValue(defaults, f)}）
                </span>
              )}
            </div>
            <input
              id={`setting-${f.key}`}
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={
                Number.isNaN(draft[f.key])
                  ? ""
                  : Number(
                      (Number(draft[f.key]) * (f.scale ?? 1)).toPrecision(12),
                    )
              }
              onChange={(e) =>
                setDraft({
                  ...draft,
                  [f.key]:
                    e.target.value === ""
                      ? NaN
                      : Number(e.target.value) / (f.scale ?? 1),
                })
              }
            />
            {differs && (
              <button
                type="button"
                className="settings-default-reset"
                onClick={() => setDraft({ ...draft, [f.key]: defaults[f.key] })}
              >
                既定に戻す
              </button>
            )}
            <small>{f.help}</small>
          </div>
        );
      })}
    </div>
  );
}
export const BasicSettings = (props: {
  saved: Settings;
  draft: Settings;
  setDraft: (s: Settings) => void;
}) => <Inputs {...props} items={fields.slice(0, 2)} />;
export function AdvancedSettings(props: {
  saved: Settings;
  draft: Settings;
  setDraft: (s: Settings) => void;
}) {
  const different = new Set(defaultDifferentKeys(props.saved));
  const toggle = (
    key: "profitGuardEnabled" | "emaGapShrinkEnabled" | "shadowEnabled",
    label: string,
    help: string,
  ) => {
    const differs = different.has(key);
    return (
      <div className="settings-toggle">
        <div className="settings-field-label">
          <label>
            <input
              type="checkbox"
              checked={props.draft[key]}
              onChange={(e) =>
                props.setDraft({ ...props.draft, [key]: e.target.checked })
              }
            />
            {label}
          </label>
          {differs && (
            <span className="settings-default-diff">
              既定と異なる（既定: {defaults[key] ? "有効" : "無効"}）
            </span>
          )}
        </div>
        {differs && (
          <button
            type="button"
            className="settings-default-reset"
            onClick={() =>
              props.setDraft({ ...props.draft, [key]: defaults[key] })
            }
          >
            既定に戻す
          </button>
        )}
        <small>{help}</small>
      </div>
    );
  };
  return (
    <details>
      <summary>詳細設定を開く</summary>
      <p>
        戦略：ルールベース（固定）。EMA20/50は平均価格の傾向、MACDは勢いを確認します。EMA・MACDの期間は既存仕様の固定値です。
      </p>
      <Inputs {...props} items={fields.slice(2)} />
      {toggle(
        "profitGuardEnabled",
        "ProfitGuardを有効にする",
        "利益条件の設定です。見積もり・費用・数量の検証とリスク制限は常に適用されます。",
      )}
      {toggle(
        "shadowEnabled",
        "影（かげの声）を有効にする",
        "AIの影運用です。売買はせず、判断の記録だけを行います。ホスト側で影が設定されている場合にだけ動きます。",
      )}
      {toggle(
        "emaGapShrinkEnabled",
        "EMAの差が縮小中も成立にする",
        "買い条件のEMAは通常「短期（EMA20）が長期（EMA50）より上」で成立します。有効にすると、短期がまだ下でも、差が「縮小とみなす連続本数」だけ縮み続いていれば成立として扱います。既定は無効です。",
      )}
    </details>
  );
}
export function SettingsChanges({
  before,
  after,
  keys,
}: {
  before: Settings;
  after: Settings;
  keys?: readonly (keyof Settings)[];
}) {
  const changed =
    keys ??
    (Object.keys(after) as (keyof Settings)[]).filter(
      (key) => !Object.is(before[key], after[key]),
    );
  return changed.length ? (
    <ul className="settings-diff">
      {changed.map((key) => {
        const field = fields.find((f) => f.key === key);
        const boolLabel =
          key === "profitGuardEnabled"
            ? "ProfitGuard"
            : key === "shadowEnabled"
              ? "かげの声"
              : key === "emaGapShrinkEnabled"
              ? "EMAの差の縮小"
              : "戦略";
        const display = (s: Settings) =>
          field
            ? formatSettingValue(s, field)
            : key === "profitGuardEnabled" ||
                key === "shadowEnabled" ||
                key === "emaGapShrinkEnabled"
              ? s[key]
                ? "有効"
                : "無効"
              : key === "strategy"
                ? "ルールベース"
                : String(s[key]);
        return (
          <li key={key}>
            <span className="diff-minus">
              - {field?.label ?? boolLabel} {display(before)}
            </span>
            <span className="diff-plus">
              + {field?.label ?? boolLabel} <strong>{display(after)}</strong>
            </span>
          </li>
        );
      })}
    </ul>
  ) : (
    <p>保存済み設定からの変更はありません。</p>
  );
}
const modeLabel = (mode: Mode) => modeCopy[mode].label;
/**
 * The settings editor state, shared by the settings form and the
 * PAPER operation controls: the start button must stay disabled
 * while the form holds unsaved edits, so both pieces read the same
 * editor instance. The strategy tab mounts this hook once and keeps
 * it mounted across segment switches, so unsaved edits survive
 * moving between the さくせん and 設定 segments.
 */
export function useSettingsEditor(
  data: State,
  api: SettingsApi,
  onSaved: () => Promise<void>,
) {
  const [editor, dispatch] = useReducer(
    settingsEditor,
    data.settings,
    createEditor,
  );
  const { saved, draft, selected, review, switchTo, status, error, conflict } =
    editor;
  const busy = status === "saving",
    dirty = !sameSettings(saved, draft);
  const lock = useRef(false);
  useEffect(() => {
    dispatch({ type: "sync", settings: data.settings });
  }, [data.settings]);
  const choose = (mode: Mode) => dispatch({ type: "select", mode });
  const edit = (next: Settings) => dispatch({ type: "edit", draft: next });
  function confirm() {
    const result = settingsSchema.safeParse(draft);
    if (!result.success) {
      dispatch({
        type: "failed",
        message: "設定値が不正です。各項目の説明と安全上限を確認してください。",
      });
      return;
    }
    dispatch({ type: "review" });
  }
  async function save() {
    if (lock.current || !review || switchTo || conflict) return;
    lock.current = true;
    dispatch({ type: "saving" });
    try {
      const result = await saveSettings(api, draft);
      await onSaved();
      dispatch({ type: "saved", settings: result });
    } catch (e) {
      dispatch({
        type: "failed",
        message:
          "設定を保存・再確認できませんでした。入力値と接続を確認して再試行してください。コード：" +
          errorCode(e),
      });
    } finally {
      lock.current = false;
    }
  }
  return {
    saved,
    draft,
    selected,
    review,
    switchTo,
    status,
    error,
    conflict,
    busy,
    dirty,
    choose,
    edit,
    confirm,
    save,
    dispatch,
  };
}
export type SettingsEditor = ReturnType<typeof useSettingsEditor>;
export function SettingsForm({ editor }: { editor: SettingsEditor }) {
  const {
    saved,
    draft,
    selected,
    review,
    switchTo,
    status,
    error,
    conflict,
    busy,
    dirty,
    choose,
    edit,
    confirm,
    save,
    dispatch,
  } = editor;
  const defaultDifferenceCount = defaultDifferentKeys(saved).length;
  return (
    <section className="easy-settings" aria-busy={busy}>
      <h2>かんたん設定</h2>
      <fieldset disabled={busy}>
        <legend>モード選択</legend>
        <p className="preset-now">いま：{modeLabel(presetName(saved))}</p>
        {selected === "custom" && (
          <aside className="settings-tip" aria-label="けんじゃのおすすめ">
            <img className="settings-tip-icon" src={partySageIcon} alt="" />
            <span>
              <strong>けんじゃのおすすめ</strong>：イージー（安全重視）
            </span>
            <button type="button" onClick={() => choose("safe")}>
              確認する
            </button>
          </aside>
        )}
        <PresetSelector value={selected} onChange={choose} />
        {defaultDifferenceCount > 0 && (
          <p className="settings-default-summary">
            既定と異なる項目: {defaultDifferenceCount}件
          </p>
        )}
        {switchTo && (
          <div
            className="settings-review"
            role="group"
            aria-label="未保存変更の確認"
          >
            <h3>未保存の変更があります</h3>
            <p>
              {modeLabel(switchTo)}
              に切り替えると、現在の未保存変更は破棄されます。保存済み設定を基準に切り替えます。
            </p>
            <button
              type="button"
              onClick={() => dispatch({ type: "discard-switch" })}
            >
              未保存の変更を破棄して切り替える
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "cancel-switch" })}
            >
              編集を続ける
            </button>
          </div>
        )}
        <BasicSettings saved={saved} draft={draft} setDraft={edit} />
        <AdvancedSettings saved={saved} draft={draft} setDraft={edit} />
        <div className="controls">
          <button
            type="button"
            disabled={!!switchTo || conflict || !dirty}
            onClick={confirm}
          >
            変更内容を確認
          </button>
          {(dirty || conflict) && (
            <button type="button" onClick={() => dispatch({ type: "restore" })}>
              未保存の変更を破棄して保存済みに戻す
            </button>
          )}
        </div>
        {review && (
          <div
            className="settings-review"
            role="group"
            aria-label="保存前の変更内容確認"
          >
            <h3>保存前の確認</h3>
            <p>適用予定：{modeLabel(selected)}</p>
            <SettingsChanges before={saved} after={draft} />
            <button type="button" onClick={() => void save()}>
              {selected === "custom"
                ? "変更を保存"
                : `${modeLabel(selected)}を適用`}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "cancel-review" })}
            >
              編集に戻る
            </button>
          </div>
        )}
      </fieldset>
      {busy && (
        <p className="settings-saving" role="status">
          保存しています…
        </p>
      )}
      {status === "applied" && (
        <p className="settings-success" role="status">
          適用済み：{modeLabel(selected)}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {/* The profit-guard state (enabled flag, minimums and the
          latest verdict) is shown once on this tab, in the
          strategy view's ProfitGuard card and detail panel;
          the toggle stays in the advanced settings. */}
    </section>
  );
}
/**
 * The full operation panel (start/stop with their gates, plus the
 * release section), composed for the combined settings page below.
 * The app's strategy tab no longer renders this panel: starting
 * and stopping were unified into the operation bar, and the tab
 * keeps only the release section (StopReleaseSection) for stopped
 * states. The gates and wording are shared — startBlockedReasons
 * feeds both this panel and the bar.
 */
export function PaperOperationControls({
  data,
  editor,
  control,
}: {
  data: State;
  editor: SettingsEditor;
  control: (c: string) => Promise<string | null>;
}) {
  const { busy, dirty, conflict, switchTo } = editor;
  const { running, emergency, error } = data.runtime;
  // Older snapshots and test fixtures may omit the mode; the labels
  // fall back to PAPER rather than rendering "undefined".
  const mode = data.mode ?? "PAPER";
  // The server-side start gate can still refuse a start the client
  // expected to pass (a long market fetch, an API backoff, a ledger
  // check...). control() hands its code back, translated below into
  // the reason shown where the operator pressed the button.
  const [startFailure, setStartFailure] = useState<string | null>(null);
  useEffect(() => {
    setStartFailure(null);
  }, [running, emergency, error]);
  async function start() {
    setStartFailure(await control("start"));
  }
  const startBlocked = startBlockedReasons(editor, data.runtime);
  return (
    <section aria-label={`${mode}運用の操作`}>
      <hr />
      <div className="paper-operation-head">
        <h3 className={`paper-operation ${running ? "running" : "stopped"}`}>
          {mode}運用
        </h3>
        <div className="paper-operation-actions">
          <button
            type="button"
            className="operation-icon-button start"
            aria-label={`${mode}運用開始`}
            title={`${mode}運用開始`}
            disabled={
              busy ||
              dirty ||
              conflict ||
              !!switchTo ||
              running ||
              emergency ||
              !!error
            }
            onClick={() => void start()}
          >
            <OperationIcon kind="start" />
          </button>
          <button
            type="button"
            className="operation-icon-button stop"
            aria-label={`${mode}運用停止`}
            title={`${mode}運用停止`}
            onClick={() => void control("stop")}
          >
            <OperationIcon kind="stop" />
          </button>
        </div>
      </div>
      {running ? (
        <p>運用中です。保存済みの設定で仮想売買を行っています。</p>
      ) : startBlocked.length > 0 ? (
        <>
          <p>今は開始できません：</p>
          <ul>
            {startBlocked.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>開始すると、保存済みの設定で仮想売買を行います。</p>
      )}
      {startFailure &&
        (isStartRecoveryWait(startFailure) ? (
          <p>{startRejectionReason(startFailure)}</p>
        ) : (
          <p className="error" role="alert">
            開始できませんでした。{startRejectionReason(startFailure)}
          </p>
        ))}
      <StopReleaseSection data={data} control={control} />
    </section>
  );
}

/**
 * Every client-side reason a start is blocked right now, spelled
 * out next to the start button wherever it lives (the operation
 * bar since the controls were unified there; the composed page
 * below): a disabled button must never leave the operator
 * guessing. The gate conditions themselves are unchanged.
 */
export function startBlockedReasons(
  editor: SettingsEditor,
  runtime: State["runtime"],
): string[] {
  const { busy, dirty, conflict, switchTo } = editor;
  const { emergency, error } = runtime;
  const blocked: string[] = [];
  if (emergency)
    blocked.push(
      "緊急停止中です。開始するには、先に下の手順で停止状態を解除してください。",
    );
  if (error)
    blocked.push(
      "安全停止中です。開始するには、先に下の手順で停止状態を解除してください。",
    );
  if (dirty)
    blocked.push(
      "未保存の変更があります。開始には保存済みの設定を使うため、先に保存するか、保存済みに戻してください。",
    );
  if (conflict)
    blocked.push(
      "編集中にサーバー側の設定が変わり、この画面の内容と競合しています。画面を再読み込みして、最新の保存済み設定を確認してください。",
    );
  if (switchTo)
    blocked.push(
      "運用スタイルの切り替えが保留中です。切り替えを確定するか取り消してから開始してください。",
    );
  if (busy)
    blocked.push("設定を保存中です。保存が終わってから開始してください。");
  return blocked;
}

/**
 * The stop-state release: the recorded reason and the release
 * button. Renders only in a stopped state (緊急停止 /
 * 安全停止). On the strategy tab it sits at the top of the page,
 * outside the segments, now that the full operation panel has
 * been unified into the operation bar — the bar's release icon
 * jumps here.
 */
export function StopReleaseSection({
  data,
  control,
  onReviewSettings,
}: {
  data: State;
  control: (
    c: string,
    extra?: Record<string, unknown>,
  ) => Promise<string | null>;
  onReviewSettings?: (field: "maxOrder") => void;
}) {
  const { emergency, error, failureDetail } = data.runtime;
  const mode = data.mode ?? "PAPER";
  // The emergency release is a two-step in-place confirmation: the
  // first press arms it, the second sends the dedicated command.
  // The scoped reset refuses emergencies by contract (PR #105), so
  // this button is the only release an owner-latched emergency has.
  const [clearArmed, setClearArmed] = useState(false);
  useEffect(() => {
    if (!emergency) setClearArmed(false);
  }, [emergency]);
  if (!emergency && !error) return null;
  const isReal = mode === "REAL";
  // A REAL stop is released only through the PC approval procedure
  // (real:resume); the dashboard reset cannot clear it, and the
  // settings advice describes the PAPER release flow. In REAL the
  // section is therefore informational: reason plus where the
  // release actually happens, with no button that cannot work.
  const advice = isReal ? null : stopSettingAdvice(data);
  return (
    <section className="stop-release">
      <div className="stop-release-head">
        <h4>{isReal && !emergency ? "安全停止中" : advice?.title ?? "停止状態の解除"}</h4>
        {emergency ? (
          <button
            type="button"
            className="operation-icon-button release"
            aria-label={clearArmed ? "緊急停止の解除を確定" : "緊急停止を解除（再開は手動）"}
            title={clearArmed ? "緊急停止の解除を確定" : "緊急停止を解除（再開は手動）"}
            onClick={() => {
              if (!clearArmed) {
                setClearArmed(true);
                return;
              }
              setClearArmed(false);
              void control("clear-emergency", { confirm: "CLEAR-EMERGENCY" });
            }}
          >
            <OperationIcon kind="release" />
            <span className="operation-action-label">
              {clearArmed ? "本当に解除する" : "緊急停止を解除"}
            </span>
          </button>
        ) : isReal ? null : (
          <button
            type="button"
            className="operation-icon-button release"
            aria-label="停止解除（再開は手動）"
            title="停止解除（再開は手動）"
            onClick={() => void control("reset")}
          >
            <OperationIcon kind="release" />
            <span className="operation-action-label">停止を解除</span>
          </button>
        )}
      </div>
      {emergency && clearArmed && (
        <p>
          緊急停止は本人の操作でのみ解除できます。解除しても自動では再開しません。
        </p>
      )}
      {!advice && (
        <p>
          {emergency
            ? `緊急停止が押され、${mode}運用を止めています。緊急停止は通常の停止解除では解けません。上のボタンからのみ解除できます。${isReal ? "解除してもREAL運用は再開しません。再開にはPCでの承認手順が別途必要です。" : ""}`
            : isReal
              ? `安全停止中です。停止理由：${reason(error ?? "")}。REAL運用の停止はこの画面からは解除できません。再開はPCでの承認手順が必要です。`
              : `安全停止中です。停止理由：${reason(error ?? "")}`}
        </p>
      )}
      {error && failureDetail && <p>詳細：{failureDetail}</p>}
      {advice && (
        <div className="stop-setting-advice">
          <p>{advice.message}</p>
          <p>{advice.action}</p>
          {advice.field && onReviewSettings && (
            <button
              type="button"
              onClick={() => onReviewSettings(advice.field!)}
            >
              取引額の設定を開く
            </button>
          )}
          {(advice.observation || advice.constraints || advice.alternative) && (
            <details>
              <summary>詳しい条件</summary>
              {advice.observation && <p>{advice.observation}</p>}
              {advice.constraints && <p>{advice.constraints}</p>}
              {advice.alternative && <p>{advice.alternative}</p>}
            </details>
          )}
        </div>
      )}
      {advice && <p>原因を解消したら「停止を解除」→「運用開始」。</p>}
    </section>
  );
}
/**
 * The settings form and the operation controls composed as one
 * page, in their historical order. The strategy tab renders the
 * two pieces separately (form inside the 設定 segment, operations
 * always visible); this composition keeps the combined rendering
 * available unchanged.
 */
export function SettingsPage({
  data,
  api,
  onSaved,
  control,
}: {
  data: State;
  api: SettingsApi;
  onSaved: () => Promise<void>;
  control: (c: string) => Promise<string | null>;
}) {
  const editor = useSettingsEditor(data, api, onSaved);
  return (
    <>
      <SettingsForm editor={editor} />
      <PaperOperationControls data={data} editor={editor} control={control} />
    </>
  );
}
