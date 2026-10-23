import type { OperationMonitor } from "../../worker/src/operations.ts";
import type { ValidationReport } from "../../worker/src/validation.ts";
export type OperationsSnapshot = ReturnType<OperationMonitor["snapshot"]> & {
  validation?: ValidationReport;
};
