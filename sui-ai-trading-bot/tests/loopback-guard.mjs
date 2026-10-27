// Test-only preloader, also inherited by settings-api's isolated worker.
// Refuse external destinations and wildcard binds before DNS or socket creation.
import { Socket, Server } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import workerThreads from "node:worker_threads";
import { fileURLToPath } from "node:url";

const key = Symbol.for("suiba.loopback-guard");
if (!globalThis[key]) {
  const loopback = (host) => ["127.0.0.1", "::1", "localhost"].includes(host);
  const originalConnect = Socket.prototype.connect;
  const originalListen = Server.prototype.listen;
  Socket.prototype.connect = function (...input) {
    const args = Array.isArray(input[0]) ? input[0] : input;
    const options = args[0];
    const host =
      options && typeof options === "object"
        ? (options.host ?? options.hostname ?? "localhost")
        : typeof args[1] === "string"
          ? args[1]
          : "localhost";
    if (
      (options && typeof options === "object" && options.path) ||
      typeof options === "string" ||
      !loopback(host)
    )
      throw Error("LOOPBACK_ONLY_CONNECT_BLOCKED");
    return Reflect.apply(originalConnect, this, input);
  };
  Server.prototype.listen = function (...args) {
    const options = args[0];
    const host =
      options && typeof options === "object"
        ? options.host
        : typeof args[1] === "string"
          ? args[1]
          : undefined;
    if (
      (options && typeof options === "object" && options.path) ||
      typeof options === "string" ||
      !loopback(host)
    )
      throw Error("LOOPBACK_ONLY_LISTEN_BLOCKED");
    return Reflect.apply(originalListen, this, args);
  };
  // ChartHistoryClient explicitly uses execArgv: [], which drops NODE_OPTIONS
  // preloads in worker threads. Keep all worker options and append only this
  // test guard so a cold history fetch cannot escape the loopback restriction.
  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class LoopbackWorker extends OriginalWorker {
    constructor(filename, options = {}) {
      super(filename, {
        ...options,
        execArgv: [
          ...(options.execArgv ?? process.execArgv),
          // Node's CommonJS eval worker does not execute --import preloads.
          // Node24 supports synchronously requiring this TLA-free ESM module.
          `--require=${fileURLToPath(import.meta.url)}`,
        ],
      });
    }
  };
  syncBuiltinESMExports();
  globalThis[key] = true;
}
