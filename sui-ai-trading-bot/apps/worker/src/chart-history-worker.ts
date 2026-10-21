import { parentPort, workerData } from "node:worker_threads";
import { ChartHistoryStore, type HistoryQuery } from "./chart-history.ts";
let gateResolve: ((ok: boolean) => void) | undefined,
  controller: AbortController | undefined;
const store = new ChartHistoryStore(workerData.path, {
  fetch,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  gate: () =>
    new Promise((resolve) => {
      gateResolve = resolve;
      parentPort!.postMessage({ kind: "gate" });
    }),
});
parentPort!.on("message", async (message) => {
  if (message.kind === "gate") {
    gateResolve?.(message.allowed);
    gateResolve = undefined;
    return;
  }
  if (message.kind === "cancel") {
    controller?.abort();
    return;
  }
  if (message.kind !== "get") return;
  controller = new AbortController();
  const deadline = setTimeout(() => controller?.abort(), 30000);
  try {
    store.seed(message.seed ?? []);
    const result = await store.get(
      message.query as HistoryQuery,
      controller.signal,
    );
    parentPort!.postMessage({ kind: "result", result });
  } catch {
    parentPort!.postMessage({
      kind: "error",
      error: "CHART_CACHE_UNAVAILABLE",
    });
  } finally {
    clearTimeout(deadline);
    controller = undefined;
  }
});
