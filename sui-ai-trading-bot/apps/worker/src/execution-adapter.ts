import type {
  Portfolio,
  QuoteResult,
  Settings,
} from "../../../packages/shared/src/index.ts";
import type { CandidateAudit } from "../../../packages/shared/src/operations.ts";
import type { ProfitReport } from "../../../packages/profit-guard/src/index.ts";
import type { RealEngineChecksRecord } from "./real/types.ts";

export interface ExecutionIntent {
  orderId: string;
  candidateId: string;
  side: "BUY" | "SELL";
  quote: QuoteResult;
  portfolio: Portfolio;
  settings: Settings;
  profitGuard: ProfitReport;
  markPrice: number;
  now: number;
  candleTimestamp: number;
}

export type ExecutionResult =
  | { status: "SUBMITTED"; digest: string }
  | { status: "REJECTED"; errorCode: string }
  | { status: "UNKNOWN"; digest: string; errorCode: string };

export interface ExecutionAdapter {
  readonly kind: "REAL_TRADECAP";
  execute(intent: ExecutionIntent): Promise<ExecutionResult>;
  acceptStop(reason: string): void;
  recordEngineChecks(record: Omit<RealEngineChecksRecord, "identity">): void;
}

export interface EngineExecutionAudit {
  audit: CandidateAudit;
  reasons: string[];
}
