import type { ValidationReport } from "../../worker/src/validation.ts";
import type { OperationMonitor } from "../../worker/src/operations.ts";
export type ValidationOperations = Pick<
  ReturnType<OperationMonitor["snapshot"]>,
  "status" | "stopReason" | "timing"
> &
  Partial<Pick<ReturnType<OperationMonitor["snapshot"]>, "safety">>;
export function validationView(
  report: ValidationReport,
  operations: ValidationOperations,
  stale = false,
) {
  const running = ["RUNNING", "DATA_DELAYED"].includes(operations.status);
  const abnormal = operations.status === "ABNORMAL_STOP";
  const complete =
    !!report.session && report.generatedAt >= report.session.targetAt;
  const passed = complete && report.status === "合格";
  const sessionLabel = !report.session
    ? "未開始"
    : complete
      ? passed
        ? "完了・合格"
        : "完了・条件未達"
      : "計測中（検証途中）";
  const waiting =
    operations.safety?.resumePending &&
    operations.safety.connectivity !== "HEALTHY";
  const botLabel = stale
    ? "状態不明"
    : waiting
      ? "通信復旧待ち（注文禁止）"
      : abnormal
        ? "異常停止"
        : running
          ? "稼働中"
          : "停止中";
  const connectionLabel = stale
    ? "状態不明"
    : !report.market
      ? "未計測"
      : !report.market.healthy
        ? "通信・データ異常"
        : !operations.timing.transportRecent
          ? "直近の通信成功を確認できません"
          : "直近の通信成功あり";
  const action = stale
    ? "画面の接続を確認し、最新の状態を取得してください。操作は状態確認後に行ってください。"
    : waiting
      ? "通信と市場データの安全確認を継続しています。注文は禁止されています。手動で開始を繰り返す必要はありません。"
      : abnormal
        ? "停止理由とデータ鮮度を確認してください。原因の解消後、既存の操作欄で安全停止を解除し、PAPER Botを手動で開始してください。計測とBotの復旧は別の操作です。"
        : !report.session
          ? running
            ? "まず既存の操作欄でBotを停止し、Profit Guardを有効にしてから「24時間計測を開始」を押してください。その後、PAPER Botを手動で開始します。"
            : "Profit Guardが有効であることを確認し、「24時間計測を開始」を押してください。開始日時の表示を確認してから、既存の操作欄でPAPER Botを手動で開始します。"
          : complete
            ? passed
              ? "既存の合格条件をすべて満たしました。下の合格条件とJSON / Markdownレポートで結果を確認してください。Botは自動停止しません。"
              : "24時間の評価が終了しましたが、合格条件を満たしていません。下に表示する未達条件と詳細記録を確認してください。自動で再検証・再開はしません。"
            : !running
              ? "計測は進行しています。取引判断の検証には、データ鮮度と安全条件を確認し、既存の操作欄からPAPER Botを手動で開始する必要があります。"
              : "計測とPAPER運用を継続中です。警告とデータ鮮度を確認しながら、24時間の記録を蓄積してください。";
  const tone =
    stale || abnormal || (complete && !passed)
      ? "danger"
      : !report.session ||
          !running ||
          operations.status === "DATA_DELAYED" ||
          report.market?.healthy !== true ||
          operations.timing.dataStatus === "STALE" ||
          operations.timing.dataStatus === "UNKNOWN" ||
          !!report.candles?.unresolved ||
          !!report.apis?.some((a) => a.failures > 0)
        ? "warning"
        : "healthy";
  return {
    sessionLabel,
    botLabel,
    connectionLabel,
    action,
    tone,
    icon: tone === "danger" ? "!" : tone === "warning" ? "△" : "✓",
    running,
    complete,
    passed,
  };
}
