import { AsyncLocalStorage } from "node:async_hooks";
import { installReadBudgetProvider, type ReadBudget } from "./read-budget.ts";
const scope = new AsyncLocalStorage<ReadBudget>();
installReadBudgetProvider(() => scope.getStore());
export function withReadBudget<T>(
  signal: AbortSignal,
  fresh: boolean,
  fn: () => Promise<T>,
  cycleId?: string,
) {
  return scope.run({ signal, fresh, ...(cycleId ? { cycleId } : {}) }, fn);
}
