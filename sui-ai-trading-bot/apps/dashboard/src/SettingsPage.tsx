import React, { useRef, useState } from "react";
import {
  settingsSchema,
  type Settings,
} from "../../../packages/shared/src/index.ts";
import type { BotEngine } from "../../worker/src/engine.ts";
import {
  applySafePreset,
  presetName,
  saveSettings,
  type SettingsApi,
} from "./settingsPresets.ts";
type State = ReturnType<BotEngine["snapshot"]>;
type Field = {
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
    help: "UTC 00:00からの累計購入額。最大20 USDC。",
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
    help: "費用控除後に必要な利益率。1.5%は内部値0.015。最大100%。",
  },
];
const format = (s: Settings, f: Field) =>
  typeof s[f.key] === "number"
    ? `${Number((Number(s[f.key]) * (f.scale ?? 1)).toPrecision(12))} ${f.unit ?? ""}`
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
        利益条件の設定です。見積もり・費用・数量の検証とRiskEngineは常に適用されます。
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
        最低純利益：{data.settings.minNetProfitUsdc} USDC ／ 最低利益率：
        {data.settings.minNetProfitPct * 100}%
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
        判定通過後もRiskEngineが確認します。
      </small>
    </div>
  );
}
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
  const [draft, setDraft] = useState<Settings>(() => ({ ...data.settings }));
  const [selected, setSelected] = useState(presetName(data.settings));
  const [pendingPreset, setPendingPreset] = useState(false);
  const [pending, setPending] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const lock = useRef(false);
  const edit = (s: Settings) => {
    setDraft(s);
    setPending(null);
    setMessage("");
    setSelected(presetName(s));
  };
  const changes = (candidate: Settings) =>
    Object.keys(candidate).filter(
      (k) =>
        candidate[k as keyof Settings] !== data.settings[k as keyof Settings],
    );
  async function save(candidate: Settings) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await saveSettings(api, candidate);
      setDraft(saved);
      setSelected(presetName(saved));
      setPending(null);
      await onSaved();
      setMessage("設定を保存し、サーバーで確認しました。");
    } catch {
      setError(
        "設定を保存・再確認できませんでした。入力値と接続を確認してください。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const preview = (candidate: Settings, isPreset = false) => {
    setPendingPreset(isPreset);
    const result = settingsSchema.safeParse(candidate);
    setMessage("");
    if (!result.success) {
      setError("設定値が不正です。各項目の説明と安全上限を確認してください。");
      return;
    }
    setError("");
    setPending(result.data);
  };
  return (
    <section className="easy-settings">
      <h2>かんたん設定</h2>
      <p>PAPER運用 · 仮想売買のみ</p>
      <fieldset disabled={busy}>
        <legend>
          運用スタイル（保存済み：
          {presetName(data.settings) === "safe" ? "安全重視" : "カスタム"}）
        </legend>
        <PresetSelector
          value={selected}
          onChange={(v) => {
            setSelected(v);
            setPending(null);
            setMessage("");
          }}
        />
        {selected === "safe" && (
          <div>
            <p>
              安全重視：最大2 USDC、日次10
              USDC、価格ずれ0.3%以下、利益保護有効、純利益0.05
              USDC・1.5%。収益性は未検証の仮設定です。
            </p>
            <button
              onClick={() => preview(applySafePreset(data.settings), true)}
            >
              安全重視の変更内容を確認
            </button>
          </div>
        )}
        <BasicSettings draft={draft} setDraft={edit} />
        <ProfitGuardSummary data={data} />
        <AdvancedSettings draft={draft} setDraft={edit} />
        <button onClick={() => preview(draft)}>設定の変更内容を確認</button>
        {pending && (
          <div className="settings-review">
            <h3>保存前の確認</h3>
            {changes(pending).length ? (
              <ul>
                {changes(pending).map((k) => {
                  const f = fields.find((f) => f.key === k);
                  return (
                    <li key={k}>
                      {f?.label ?? "利益保護"}：
                      {f
                        ? format(data.settings, f)
                        : data.settings.profitGuardEnabled
                          ? "有効"
                          : "無効"}{" "}
                      →{" "}
                      {f
                        ? format(pending, f)
                        : pending.profitGuardEnabled
                          ? "有効"
                          : "無効"}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p>変更はありません。</p>
            )}
            <p>表示以外の項目は保持します。Botは起動しません。</p>
            <button onClick={() => void save(pending)}>
              {pendingPreset ? "安全重視を適用" : "変更を保存"}
            </button>
            <button onClick={() => setPending(null)}>キャンセル</button>
          </div>
        )}
      </fieldset>
      {busy && <p role="status">保存・再確認中…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <hr />
      <h3>PAPER運用 {data.runtime.running ? "稼働中" : "停止中"}</h3>
      <div className="controls">
        <button
          disabled={
            busy ||
            data.runtime.running ||
            data.runtime.emergency ||
            !!data.runtime.error
          }
          onClick={() => void control("start")}
        >
          PAPER運用開始
        </button>
        <button onClick={() => void control("stop")}>PAPER運用停止</button>
      </div>
      {(data.runtime.emergency || data.runtime.error) && (
        <details>
          <summary>停止状態の解除</summary>
          <p>原因を確認後に解除してください。再開は別途手動です。</p>
          <button onClick={() => void control("reset")}>
            停止解除（再開は手動）
          </button>
        </details>
      )}
    </section>
  );
}
