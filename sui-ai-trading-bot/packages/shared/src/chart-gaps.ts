export type GapCause =
  | "NO_TRADES_VERIFIED"
  | "INDEXER_MISSING"
  | "PAGINATION_GAP"
  | "DATA_INVALID"
  | "UNKNOWN";
export const gapCauseLabels: Record<GapCause, string> = {
  NO_TRADES_VERIFIED: "約定なしを検証済み（公式Indexer）",
  INDEXER_MISSING: "IndexerのOHLCV欠損",
  PAGINATION_GAP: "ページング処理の欠落",
  DATA_INVALID: "不正データ",
  UNKNOWN: "原因未確定",
};
export function classifyChartGap(input: {
  timestamp: number;
  trades: { timestamp: number }[] | null;
  complete: boolean;
  validRange: boolean;
  indexedThrough: number;
  minuteCount: number;
  fivePresent: boolean;
  invalid?: boolean;
  excludedByPaging?: boolean;
}): GapCause {
  if (input.invalid) return "DATA_INVALID";
  if (input.excludedByPaging) return "PAGINATION_GAP";
  if (
    input.fivePresent ||
    input.minuteCount > 0 ||
    input.trades?.some(
      (t) =>
        t.timestamp >= input.timestamp * 1000 &&
        t.timestamp < (input.timestamp + 300) * 1000,
    )
  )
    return "INDEXER_MISSING";
  return input.trades != null &&
    input.trades.length === 0 &&
    input.complete &&
    input.validRange &&
    input.indexedThrough >= (input.timestamp + 300) * 1000
    ? "NO_TRADES_VERIFIED"
    : "UNKNOWN";
}
