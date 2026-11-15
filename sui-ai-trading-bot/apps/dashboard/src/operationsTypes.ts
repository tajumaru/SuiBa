import type { OperationMonitor } from "../../worker/src/operations.ts";
import type { PaperCheckSession } from "../../worker/src/paper-check-session.ts";
import type { ValidationReport } from "../../worker/src/validation.ts";
import type { SituationMemory } from "../../worker/src/situation-memory.ts";
/** The worker's effective execution environment (see /api/operations). */
export interface EnvironmentInfo {
  mode: string;
  pair: string;
  provider: string | null;
  paperCheck: ReturnType<PaperCheckSession["status"]>;
  maintenance: boolean;
}
export type OperationsSnapshot = ReturnType<OperationMonitor["snapshot"]> & {
  validation?: ValidationReport;
  /** Absent when the running worker predates the environment block. */
  environment?: EnvironmentInfo;
  memwal?: {
    enabled: boolean;
    pending: number;
    lastSuccessAt: number | null;
  };
  situationMemory?: SituationMemory | null;
};
