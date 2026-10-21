import { operationReason } from "./operationLabels.ts";

export const labels: Record<string, string> = {
  BUY: "買い",
  SELL: "売り",
  WAIT: "見送り",
  SAFE_STOP: "安全停止",
  PENDING: "処理中",
  REJECTED: "拒否",
  FILLED: "約定済み",
  TAKE_PROFIT: "利確",
  STOP_LOSS: "損切り",
  STRATEGY_EXIT: "戦略による売却",
  RISK_REDUCTION: "リスク削減",
  EMERGENCY_EXIT: "緊急売却",
  Overview: "ダッシュボード",
  Chart: "チャート",
  Strategy: "戦略",
  "Trading History": "取引履歴",
  Settings: "設定",
  Price: "価格",
  maxDrawdown: "最大ドローダウン",
  winRate: "勝率",
  profitFactor: "利益と損失の比率",
};
export const label = (value: unknown) => labels[String(value)] ?? "未確認";
export function number(value: number | string | null | undefined, digits = 6) {
  if (value == null || value === "" || !Number.isFinite(Number(value)))
    return "—";
  // Decimal strings retain every supplied digit, including values beyond Number's precision.
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    const [whole, fraction] = value.split(".");
    return (
      whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
      (fraction ? `.${fraction}` : "")
    );
  }
  return new Intl.NumberFormat("ja-JP", {
    maximumFractionDigits: digits,
  }).format(Number(value));
}
export const percent = (value: number | string | null | undefined) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("ja-JP", {
        style: "percent",
        maximumFractionDigits: 4,
      }).format(Number(value));
export function dateTime(value: number | string | null | undefined) {
  if (value == null) return "未取得";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "日時不明"
    : new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date) + "（日本時間）";
}
export const reason = (code: string) =>
  /[ぁ-んァ-ヶ一-龠]/.test(code) ? code : operationReason(code);
export function nextStep(code: string) {
  if (/429|BACKOFF|RETRIES/.test(code))
    return "運用検証で次回再試行可能時刻を確認し、接続回復後に設定で停止解除し、PAPER運用を開始してください。";
  if (/LEDGER|MISMATCH|RECONCILIATION|POSITION|BALANCE/.test(code))
    return "運用検証で残高・損益の照合記録を確認し、不整合の原因を解消してから設定で停止解除してください。再開は手動です。";
  if (/PROFIT|MAX_|LIMIT|SLIPPAGE/.test(code))
    return "運用検証で見送りの条件を確認してください。条件を満たすまで売買を見送ります。";
  return "運用検証で外部データと接続状態を確認し、原因を解消してから設定で停止解除し、PAPER運用を開始してください。";
}
export function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{0,100}$/.test(message) ? message : "REQUEST_FAILED";
}
