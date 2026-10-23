export type ReadBudget = {
  signal: AbortSignal;
  fresh: boolean;
  cycleId?: string;
};
let provider: () => ReadBudget | undefined = () => undefined;
export const currentReadBudget = () => provider();
// Installed by the worker only; browser consumers of shared/api remain Node-free.
export function installReadBudgetProvider(value: typeof provider) {
  provider = value;
}
export function abortable<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
