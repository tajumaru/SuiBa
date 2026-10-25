import React, { useEffect, useReducer, useRef } from "react";
import {
  settingsSchema,
  type Settings,
} from "../../../packages/shared/src/index.ts";
import type { BotEngine } from "../../worker/src/engine.ts";
import {
  presetKeys,
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
import { number, percent, errorCode } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
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
    label: "SUIの最大保有比率",
    unit: "%",
    scale: 100,
    help: "仮想総資産に占めるSUIの割合。最大20%。",
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
];
export const formatSettingValue = (s: Settings, f: Field) =>
  typeof s[f.key] === "number"
    ? `${number(Number((Number(s[f.key]) * (f.scale ?? 1)).toPrecision(12)))} ${f.unit ?? ""}`
    : String(s[f.key]);
export function PresetSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: "safe" | "custom") => void;
}) {
  return (
    <div className="preset-cards" role="group" aria-label="運用スタイル">
      {(["safe", "custom"] as const).map((v) => (
        <button
          type="button"
          key={v}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
          <strong>{v === "safe" ? "安全重視" : "カスタム"}</strong>
          <small>
            {v === "safe" ? "小さな金額でPAPER検証" : "自分で設定を調整"}
          </small>
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
    </details>
  );
}
export function ProfitGuardSummary({ data }: { data: State }) {
  const r = data.profitGuard;
  const insufficient =
    r &&
    ["MINIMUM_NET_PROFIT_NOT_MET", "PROJECTED_NET_INSUFFICIENT"].includes(
      r.reason,
    );
  const reasons: Record<string, string> = {
    MINIMUM_NET_PROFIT_NOT_MET:
      "手数料込みの利益が基準に届かないため、売買を見送りました",
    PROJECTED_NET_INSUFFICIENT:
      "想定利益が費用または最低基準に届かないため、購入を見送りました",
    QUOTE_EXPIRED: "価格情報が古いため、売買を見送りました",
    QUOTE_UNAVAILABLE: "価格の見積もりを取得できません",
    UNKNOWN_COSTS: "費用を確認できないため、売買を見送りました",
    INVALID_QUOTE: "見積もりの数量・方向などが不正です",
    INVALID_POSITION: "保有数量または取得原価が不正です",
    INSUFFICIENT_POSITION: "売却数量が保有数量を超えています",
    INVALID_PROFIT_CONFIG: "利益保護の設定が不正です",
    PROFIT_DATA_UNKNOWN: "利益計算に必要なデータが不足しています",
    PROTECTIVE_EXIT_PROFIT_DATA_UNAVAILABLE:
      "リスク削減では利益条件のみ免除します。安全性の検証は必須です",
    PROTECTIVE_EXIT_PROFIT_BYPASS:
      "損切り・リスク削減のため利益条件のみ免除しました",
    MINIMUM_NET_PROFIT_MET: "費用控除後の最低利益を満たしました",
    PROJECTED_NET_EXCEEDS_ROUND_TRIP_COST:
      "想定純利益が往復費用と最低基準を満たしました",
    PROFIT_GUARD_DISABLED: "利益条件は無効です。安全性の検証は継続します",
  };
  return (
    <div className="profit-summary">
      <h3>利益保護：{data.settings.profitGuardEnabled ? "有効" : "無効"}</h3>
      <p>
        最低純利益：{number(data.settings.minNetProfitUsdc)} USDC ／
        最低利益率：
        {percent(data.settings.minNetProfitPct)}
      </p>
      <p>
        最後の判定：
        {!r
          ? "データ不足"
          : r.allowed
            ? "取引許可"
            : insufficient
              ? "利益不足で見送り"
              : "データ不足"}
      </p>
      <small>
        {r
          ? (reasons[r.reason] ??
            "安全性を確認できないため、売買を見送りました")
          : "判定データはまだありません。"}{" "}
        {r && <Reason code={r.reason} />}判定通過後もリスク制限が確認します。
      </small>
    </div>
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
        const display = (s: Settings) =>
          field
            ? formatSettingValue(s, field)
            : key === "profitGuardEnabled"
              ? s[key]
                ? "有効"
                : "無効"
              : key === "strategy"
                ? "ルールベース"
                : String(s[key]);
        return (
          <li key={key}>
            <span>
              {field?.label ??
                (key === "profitGuardEnabled" ? "利益保護" : "戦略")}
            </span>
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
const modeLabel = (mode: Mode) => (mode === "safe" ? "安全重視" : "カスタム");
export function SettingsPage({
  data,
  api,
  onSaved,
  control,
}: {
  data: State;
  api: SettingsApi;
  onSaved: () => Promise<void>;
  control: (c: string) => Promise<void>;
}) {
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
  return (
    <section className="easy-settings" aria-busy={busy}>
      <h2>かんたん設定</h2>
      <p>PAPER専用 · 仮想売買のみ</p>
      <fieldset disabled={busy}>
        <legend>
          運用スタイル（保存済み：{modeLabel(presetName(saved))}）
        </legend>
        <small>
          選択しただけでは保存されません。PAPER運用には保存済みの設定を使います。
        </small>
        {selected === "custom" && (
          <aside className="settings-tip" aria-label="安全重視のおすすめ">
            <strong>安全重視をおすすめ</strong>
            <p>
              初めての方には安全重視がおすすめです。少額の仮想売買でSuiBaの動作を確認できます。
            </p>
            <button type="button" onClick={() => choose("safe")}>
              安全重視の設定を確認する
            </button>
          </aside>
        )}
        <PresetSelector value={selected} onChange={choose} />
        <p>
          選択中の運用スタイル：<strong>{modeLabel(selected)}</strong>
        </p>
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
        <div className="settings-preview" aria-label="適用予定の設定">
          <h3>
            適用予定：{modeLabel(selected)}
            {dirty ? "（未保存）" : "（保存済み値と同じ）"}
          </h3>
          {selected === "safe" && (
            <p>
              純利益0.05
              USDC・1.5%以上を目標にする仮設定です。収益性は未検証です。選択だけでは保存・起動されません。
            </p>
          )}
          <small>保存済み → 適用予定</small>
          <SettingsChanges
            before={saved}
            after={draft}
            keys={selected === "safe" ? presetKeys : undefined}
          />
        </div>
        <h3>適用予定の数値を編集</h3>
        <small>数値を編集すると選択中のスタイルはカスタムになります。</small>
        <BasicSettings draft={draft} setDraft={edit} />
        <AdvancedSettings draft={draft} setDraft={edit} />
        {dirty && (
          <p className="unsaved-note">
            未保存の変更があります。保存するまでPAPER運用には反映されません。
          </p>
        )}
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
            <p>
              ここに表示されない設定は保持します。設定の保存だけではボットは起動しません。
            </p>
            <button type="button" onClick={() => void save()}>
              {selected === "safe" ? "安全重視を適用" : "変更を保存"}
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
          保存・サーバーへの再確認中です。完了までお待ちください…
        </p>
      )}
      {status === "applied" && (
        <p className="settings-success" role="status">
          適用済み：{modeLabel(selected)}
          。保存完了後の設定をサーバーで確認しました。PAPER運用の開始は下のボタンから行ってください。
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
        <ProfitGuardSummary data={{ ...data, settings: saved }} />
      </div>
      <hr />
      <h3
        className={`paper-operation ${data.runtime.running ? "running" : "stopped"}`}
      >
        PAPER運用：
        {data.runtime.emergency
          ? "緊急停止中"
          : data.runtime.error
            ? "安全停止中"
            : data.runtime.running
              ? "運用中"
              : "停止中"}
      </h3>
      <p>
        {dirty || conflict
          ? "未保存の変更を保存するか、保存済みに戻してから開始してください。"
          : "開始すると、上の保存済み設定で仮想売買を行います。"}
      </p>
      <div className="controls">
        <button
          type="button"
          disabled={
            busy ||
            dirty ||
            conflict ||
            !!switchTo ||
            data.runtime.running ||
            data.runtime.emergency ||
            !!data.runtime.error
          }
          onClick={() => void control("start")}
        >
          PAPER運用開始
        </button>
        <button type="button" onClick={() => void control("stop")}>
          PAPER運用停止
        </button>
      </div>
      {(data.runtime.emergency || data.runtime.error) && (
        <details>
          <summary>停止状態の解除</summary>
          <p>原因を確認後に解除してください。再開は別途手動です。</p>
          <button type="button" onClick={() => void control("reset")}>
            停止解除（再開は手動）
          </button>
        </details>
      )}
    </section>
  );
}
