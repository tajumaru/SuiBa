import React, { useEffect, useRef, useState } from "react";
import type { OperationsSnapshot } from "./operationsTypes.ts";
import type { SettingsApi } from "./settingsPresets.ts";
import {
  validationControl,
  validationReadiness,
  type ControlState,
  type Readiness,
} from "./validationControl.ts";
import { validationView } from "./validationView.ts";
import { errorCode, reason } from "./presentation.ts";

export function ValidationControl({
  data,
  state,
  stale = false,
  api,
  refresh,
  readiness = validationReadiness,
}: {
  data: OperationsSnapshot;
  state?: ControlState;
  stale?: boolean;
  api?: SettingsApi;
  refresh?: () => Promise<void>;
  readiness?: Readiness;
}) {
  const confirmation = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<
    "measure" | "start" | "stop" | "reset" | null
  >(null);
  const [notice, setNotice] = useState("");
  const [operationError, setOperationError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    setUncertain(false);
  }, [data, state]);
  useEffect(() => {
    const dialog = confirmation.current;
    if (pending && dialog) {
      dialog.showModal();
      return () => dialog.close();
    }
  }, [pending]);
  const v = validationControl(data, state, stale || uncertain, readiness);
  const view = data.validation
    ? validationView(data.validation, data, stale)
    : null;
  const execute = async () => {
    if (!pending || !api || busy) return;
    if (pending === "reset" && (stale || uncertain || !v.abnormal)) return;
    if (
      (pending === "measure" && v.measureReasons.length) ||
      (pending === "start" && v.startReasons.length)
    )
      return;
    setBusy(true);
    setOperationError("");
    const command = pending;
    setPending(null);
    try {
      if (command === "measure") await api("validation/start", {});
      else await api("control", { command });
      setNotice(
        command === "measure"
          ? "24時間計測を開始しました。開始日時の更新を確認してから、ステップ2へ進んでください。"
          : command === "reset"
            ? "停止状態を解除しました。Botは停止したままです。再開は手動です。"
            : command === "stop"
              ? "PAPER Botを停止しました。自動再開は取り消されます。計測記録は継続します。"
              : "PAPER Botの開始を受け付けました。最新の稼働状態を確認してください。",
      );
    } catch (e) {
      setOperationError(errorCode(e));
      const remedies: Record<string, string> = {
        STOP_BEFORE_VALIDATION: "Botを停止してから計測を開始してください",
        PROFIT_GUARD_REQUIRED: "設定でProfit Guardを有効にして保存してください",
        VALIDATION_ALREADY_STARTED:
          "計測は開始済みです。記録を上書きせず、表示の更新を待ってください",
        RESET_REQUIRED:
          "停止原因を解消してRESETで解除してください。再開は別の操作です",
        API_BACKOFF: "APIの待機時間と停止原因を確認してください",
        ACCOUNTING_CHECK_REQUIRED:
          "台帳の不整合があります。詳細診断で記録を確認してください",
      };
      setNotice(
        `操作を完了できません。${remedies[errorCode(e)] ?? reason(errorCode(e))}。詳細診断と最新状態を確認してください。`,
      );
    } finally {
      // A failed response may still have applied. Require fresh reads before another start.
      setUncertain(true);
      try {
        if (refresh) {
          await refresh();
          setUncertain(false);
        }
      } catch {
        /* remain blocked */
      }
      setBusy(false);
    }
  };
  const blocked = busy || !api;
  const labels = {
    measure: "24時間計測を開始",
    start: "PAPER Botを開始",
    stop: "PAPER Botを停止",
    reset: "RESET：停止状態を解除",
  };
  return (
    <section
      className={`validation-control ${v.tone}`}
      aria-label="運用検証コントロール"
    >
      <div className="control-header">
        <div>
          <h2>運用検証コントロール</h2>
          <p className="control-state" role="status">
            <span aria-hidden="true">
              {v.tone === "healthy"
                ? "✓"
                : v.tone === "danger"
                  ? "!"
                  : v.tone === "warning"
                    ? "△"
                    : "○"}
            </span>{" "}
            {stale || uncertain
              ? "状態不明"
              : v.abnormal
                ? "異常・緊急停止"
                : data.safety?.connectivity === "DEGRADED"
                  ? "通信不安定（注文禁止）"
                  : data.safety?.connectivity === "RECOVERING"
                    ? "復旧確認中（注文禁止）"
                    : data.safety?.resumePending
                      ? "通信復旧待ち（注文禁止）"
                      : v.running
                        ? data.status === "DATA_DELAYED"
                          ? "稼働中・データ遅延"
                          : "PAPER Bot稼働中"
                        : v.tone === "ready"
                          ? "開始可能"
                          : "PAPER Bot停止中"}
          </p>
        </div>
        {(v.running || data.safety?.resumePending || stale || uncertain) && (
          <button
            className="control-stop"
            disabled={blocked}
            onClick={() => setPending("stop")}
          >
            {labels.stop}
          </button>
        )}
      </div>
      <div className="control-result">
        <strong>24時間検証：{view?.sessionLabel ?? "利用不可"}</strong>
        {view?.complete && (
          <p>評価は終了しました。検証結果と未達条件は下で確認できます。</p>
        )}
      </div>
      {!v.running && (
        <>
          <h3>次に必要な操作</h3>
          <p>
            {stale || uncertain
              ? "最新の状態を取得してください。開始と解除は状態確認までできません。"
              : v.abnormal
                ? "停止理由と詳細診断を確認し、原因の解消後にRESETで解除してください。その後のPAPER開始は別の手動操作です。"
                : data.safety?.resumePending
                  ? "通信と安全条件の復旧確認を待ってください。停止すると自動再開を取り消します。"
                  : view?.complete || v.running
                    ? view?.action
                    : readiness.status !== "GO"
                      ? `開始禁止：${readiness.reason} 画面内で承認を変更することはできません。`
                      : !data.validation
                        ? "検証専用環境と接続状態を確認してください。"
                        : data.validation.session
                          ? "ステップ2でPAPER Botを手動で開始してください。開始できない場合はボタン直下の理由を確認してください。"
                          : "ステップ1で24時間計測を開始し、開始日時を確認してからステップ2へ進んでください。"}
          </p>
          {!!data.validation?.session && !v.running && !view?.complete && (
            <p className="control-warning" role="alert">
              計測だけが進行しています。PAPER
              Botは停止中のため、PAPER稼働時間は増えません。
            </p>
          )}
        </>
      )}
      {data.stopReason && (
        <p>
          現在の停止理由：
          {reason(data.stopReason ?? data.safety.lastStopReason!)}
        </p>
      )}
      {!v.running && (
        <ol className="control-steps">
          <li>
            <h3>24時間の記録を開始</h3>
            {data.validation?.session ? (
              <p>✓ 計測は開始済みです。開始日時と進捗は下に表示しています。</p>
            ) : (
              <>
                <p>
                  Botを停止し、Profit
                  Guardと事前承認を確認します。この操作ではBotは動きません。
                </p>
                <button
                  className="control-primary"
                  disabled={blocked || !!v.measureReasons.length}
                  aria-describedby="measure-reasons"
                  onClick={() => setPending("measure")}
                >
                  {labels.measure}
                </button>
                <div id="measure-reasons">
                  {v.measureReasons.map((r) => (
                    <p key={r}>{r}</p>
                  ))}
                  {!api && <p>操作APIに接続できません。</p>}
                </div>
              </>
            )}
          </li>
          <li>
            <h3>PAPER Botを手動で開始</h3>
            <p>
              開始日時を確認後、保存済み設定で仮想売買を開始します。LIVE取引は行いません。
            </p>
            <button
              className="control-primary"
              disabled={blocked || !!v.startReasons.length}
              aria-describedby="start-reasons"
              onClick={() => setPending("start")}
            >
              {labels.start}
            </button>
            <div id="start-reasons">
              {v.startReasons.map((r) => (
                <p key={r}>{r}</p>
              ))}
              {!api && <p>操作APIに接続できません。</p>}
            </div>
          </li>
        </ol>
      )}
      {v.abnormal && (
        <div className="control-secondary">
          {v.abnormal && (
            <>
              <button
                disabled={blocked || stale || uncertain}
                onClick={() => setPending("reset")}
              >
                {labels.reset}
              </button>
              <p>
                通信・データ鮮度・台帳と停止原因を確認後に解除してください。記録や残高を削除せず、Botは再開しません。
              </p>
            </>
          )}
        </div>
      )}
      <details className="control-details">
        <summary>開始条件・操作の説明・過去の停止理由</summary>
        <p>
          事前判定：
          <strong>
            {readiness.status === "GO"
              ? "GO（開始準備の承認済み・24時間検証の合格ではありません）"
              : "NO-GO（開始禁止）"}
          </strong>
        </p>
        {v.running && readiness.status !== "GO" && (
          <p>
            この判定は新たに開始する際の承認条件です。現在の稼働状態とは別です。
          </p>
        )}
        {!data.stopReason && data.safety?.lastStopReason && (
          <p>
            過去の停止理由（現在は解除済み）：
            {reason(data.safety.lastStopReason)}
          </p>
        )}
        <p>
          手動停止すると自動復旧による再開も取り消します。24時間計測は終了しません。
        </p>
        <p>
          検証：{view?.sessionLabel ?? "利用不可"}
          。24時間経過で評価が完了します。計測終了ボタンはありません。Botは自動停止しません。完了と正常稼働完走・合格は別です。
        </p>
      </details>
      {pending && (
        <dialog
          ref={confirmation}
          className="control-confirm"
          aria-labelledby="control-confirm-title"
          onCancel={() => setPending(null)}
        >
          <h3 id="control-confirm-title">{labels[pending]}の確認</h3>
          <p>
            {pending === "reset"
              ? "停止原因は解消していますか？解除後もBotは停止します。"
              : pending === "stop"
                ? "PAPER Botを停止し、自動再開を取り消します。計測は継続します。"
                : pending === "measure"
                  ? "保存した記録は上書きできません。Botの開始は別の手動操作です。"
                  : "事前GOと開始承認、保存済み設定、安全条件を確認しましたか？"}
          </p>
          <button
            className={pending === "stop" ? "control-stop" : "control-primary"}
            disabled={
              blocked ||
              (pending === "measure" && !!v.measureReasons.length) ||
              (pending === "start" && !!v.startReasons.length)
            }
            onClick={() => void execute()}
          >
            確認して実行
          </button>
          <button disabled={busy} onClick={() => setPending(null)}>
            キャンセル
          </button>
        </dialog>
      )}
      {busy && <p role="status">操作と最新状態を確認中…</p>}
      {notice && <p role="status">{notice}</p>}
      {operationError && (
        <details>
          <summary>操作エラーの詳細</summary>
          <code>{operationError}</code>
        </details>
      )}
    </section>
  );
}
