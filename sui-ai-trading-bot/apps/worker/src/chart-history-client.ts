import { Worker } from "node:worker_threads";
import type {
  Candle,
  TradingPair,
} from "../../../packages/shared/src/index.ts";
import type { HistoryQuery, HistoryResult } from "./chart-history.ts";
export class ChartHistoryClient {
  private worker: Worker | null = null;
  private pending: {
    key: string;
    promise: Promise<HistoryResult>;
    resolve: (r: HistoryResult) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  constructor(
    private path: string,
    private allowed: () => boolean,
    private pair: TradingPair = "SUI_USDC",
  ) {}
  cancel() {
    this.worker?.postMessage({ kind: "cancel" });
  }
  close() {
    this.pending?.reject(Error("CHART_CANCELLED"));
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    const terminated = this.worker?.terminate();
    this.worker = null;
    return terminated;
  }
  get(query: HistoryQuery, seed: Candle[]) {
    const key = JSON.stringify(query);
    if (this.pending) {
      if (this.pending.key === key) return this.pending.promise;
      return Promise.reject(Error("CHART_BUSY"));
    }
    if (!this.worker) {
      this.worker = new Worker(
        `const {workerData}=require("node:worker_threads");require("tsx/esm/api").tsImport(workerData.entry,workerData.entry);`,
        {
          eval: true,
          execArgv: [],
          workerData: {
            path: this.path,
            pair: this.pair,
            entry: new URL("./chart-history-worker.ts", import.meta.url).href,
          },
        },
      );
      const currentWorker = this.worker;
      this.worker.unref();
      this.worker.on("message", (m) => {
        if (this.worker !== currentWorker) return;
        if (m.kind === "gate") {
          this.worker?.postMessage({ kind: "gate", allowed: this.allowed() });
          return;
        }
        const p = this.pending;
        if (!p) return;
        clearTimeout(p.timer);
        this.pending = null;
        if (m.kind === "result") p.resolve(m.result);
        else p.reject(Error("CHART_CACHE_UNAVAILABLE"));
      });
      this.worker.on("error", () => {
        if (this.worker === currentWorker) this.close();
      });
      this.worker.on("exit", () => {
        if (this.worker === currentWorker) this.close();
      });
    }
    let resolve!: (r: HistoryResult) => void, reject!: (e: Error) => void;
    const promise = new Promise<HistoryResult>((a, b) => {
      resolve = a;
      reject = b;
    });
    const timer = setTimeout(() => this.close(), 35000);
    this.pending = { key, promise, resolve, reject, timer };
    this.worker.postMessage({ kind: "get", query, seed });
    return promise;
  }
}
