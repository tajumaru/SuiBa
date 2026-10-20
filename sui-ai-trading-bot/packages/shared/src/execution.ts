/** Mode-specific execution contracts. LIVE currently returns an unsigned simulation only. */
export interface TradingExecutor<
  Mode extends "PAPER" | "LIVE",
  Request,
  Result,
> {
  readonly mode: Mode;
  prepare(request: Request): Promise<Result>;
}
