import React, { useEffect, useReducer, useRef, useState } from "react";
import {
  settingsSchema,
  type Settings,
} from "../../../packages/shared/src/index.ts";
import type { BotEngine } from "../../worker/src/engine.ts";
import {
  presetName,
  saveSettings,
  type SettingsApi,
} from "./settingsPresets.ts";
import {
  createEditor,
  settingsEditor,
  sameSettings,
  type Mode,
} from "./settingsEditor.ts";
import { number, errorCode, reason } from "./presentation.ts";
import { startRejectionReason } from "./operationLabels.ts";
import { OperationIcon } from "./operationIcons.tsx";
type State = ReturnType<BotEngine["snapshot"]>;
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
    help: "1注文で使える金額の上限。最大5 USDC。",
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
    help: "取得価格からの上昇割合。最大30%。利益保護も確認します。",
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
const modeCopy: Record<Mode, { label: string; blurb: string }> = {
  safe: { label: "安全重視", blurb: "小さな金額でPAPER検証" },
  hard: { label: "ハードモード", blurb: "よく売買する・荒い" },
  custom: { label: "カスタム", blurb: "自分で設定を調整" },
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
          <strong>{modeCopy[v].label}</strong>
          <small>{modeCopy[v].blurb}</small>
        </button>
      ))}
    </div>
  );
}
function Inputs({
  draft,
  setDraft,
  items,
}: {
  draft: Settings;
  setDraft: (s: Settings) => void;
  items: Field[];
}) {
  return (
    <div className="settings-grid">
      {items.map((f) => (
        <label key={f.key}>
          {f.label} {f.unit && `(${f.unit})`}
          <input
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
          <small>{f.help}</small>
        </label>
      ))}
    </div>
  );
}
export const BasicSettings = (props: {
  draft: Settings;
  setDraft: (s: Settings) => void;
}) => <Inputs {...props} items={fields.slice(0, 2)} />;
export function AdvancedSettings(props: {
  draft: Settings;
  setDraft: (s: Settings) => void;
}) {
  return (
    <details>
      <summary>詳細設定を開く</summary>
      <p>
        戦略：ルールベース（固定）。EMA20/50は平均価格の傾向、MACDは勢いを確認します。EMA・MACDの期間は既存仕様の固定値です。
      </p>
      <Inputs {...props} items={fields.slice(2)} />
      <label>
        <input
          type="checkbox"
          checked={props.draft.profitGuardEnabled}
          onChange={(e) =>
            props.setDraft({
              ...props.draft,
              profitGuardEnabled: e.target.checked,
            })
          }
        />
        利益保護を有効にする
      </label>
      <small>
        利益条件の設定です。見積もり・費用・数量の検証とリスク制限は常に適用されます。
      </small>
      <label>
        <input
          type="checkbox"
          checked={props.draft.emaGapShrinkEnabled}
          onChange={(e) =>
            props.setDraft({
              ...props.draft,
              emaGapShrinkEnabled: e.target.checked,
            })
          }
        />
        EMAの差が縮小中も成立にする
      </label>
      <small>
        買い条件のEMAは通常「短期（EMA20）が長期（EMA50）より上」で成立します。有効にすると、短期がまだ下でも、差が「縮小とみなす連続本数」だけ縮み続いていれば成立として扱います。既定は無効です。
      </small>
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
            ? "利益保護"
            : key === "emaGapShrinkEnabled"
              ? "EMAの差の縮小"
              : "戦略";
        const display = (s: Settings) =>
          field
            ? formatSettingValue(s, field)
            : key === "profitGuardEnabled" || key === "emaGapShrinkEnabled"
              ? s[key]
                ? "有効"
                : "無効"
              : key === "strategy"
                ? "ルールベース"
                : String(s[key]);
        return (
          <li key={key}>
            <span>{field?.label ?? boolLabel}</span>
            <span>
              {display(before)} → <strong>{display(after)}</strong>
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
 * moving between the ルール and 設定 segments.
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
  return (
    <section className="easy-settings" aria-busy={busy}>
      <h2>かんたん設定</h2>
      <fieldset disabled={busy}>
        <legend>
          運用スタイル（保存済み：{modeLabel(presetName(saved))}）
        </legend>
        {selected === "custom" && (
          <aside className="settings-tip" aria-label="安全重視のおすすめ">
            <strong>安全重視をおすすめ</strong>
            <button type="button" onClick={() => choose("safe")}>
              安全重視の設定を確認する
            </button>
          </aside>
        )}
        <PresetSelector value={selected} onChange={choose} />
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
        <BasicSettings draft={draft} setDraft={edit} />
        <AdvancedSettings draft={draft} setDraft={edit} />
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
      <div className="settings-saved" aria-label="保存済みの設定">
        <h3>保存済みの設定</h3>
        <p>
          最大取引額：{number(saved.maxOrder)} USDC ／ 1日の購入上限：
          {number(saved.dailyBuyLimit)} USDC
        </p>
        {/* The profit-guard state (enabled flag, minimums and the
            latest verdict) is shown once on this tab, in the
            strategy view's ProfitGuard card and detail panel;
            the toggle stays in the advanced settings. */}
      </div>
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
    <section aria-label="PAPER運用の操作">
      <hr />
      <div className="paper-operation-head">
        <h3 className={`paper-operation ${running ? "running" : "stopped"}`}>
          PAPER運用
        </h3>
        <div className="paper-operation-actions">
          <button
            type="button"
            className="operation-icon-button start"
            aria-label="PAPER運用開始"
            title="PAPER運用開始"
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
            aria-label="PAPER運用停止"
            title="PAPER運用停止"
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
      {startFailure && (
        <p className="error" role="alert">
          開始できませんでした。{startRejectionReason(startFailure)}
        </p>
      )}
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
 * The stop-state release: reason, confirmation steps and the
 * release button. Renders only in a stopped state (緊急停止 /
 * 安全停止). On the strategy tab it sits at the top of the page,
 * outside the segments, now that the full operation panel has
 * been unified into the operation bar — the bar's release icon
 * jumps here.
 */
export function StopReleaseSection({
  data,
  control,
}: {
  data: State;
  control: (c: string) => Promise<string | null>;
}) {
  const { emergency, error } = data.runtime;
  if (!emergency && !error) return null;
  return (
    <section className="stop-release">
      <div className="stop-release-head">
        <h4>停止状態の解除</h4>
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
      </div>
      <p>
        {emergency
          ? "緊急停止が押され、PAPER運用を止めています。"
          : `安全停止中です。停止理由：${reason(error ?? "")}`}
      </p>
      <ol>
        <li>「検証」で停止した原因を確認します。</li>
        <li>原因を解消したら「停止を解除」を押します。</li>
        <li>
          上の「運用開始」を押すと再開します。解除だけでは売買を始めません。
        </li>
      </ol>
      <p>停止した原因が残っていると、再開しても再び停止します。</p>
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
