import { Worker } from "node:worker_threads";
import { once } from "node:events";
/** Only use with a freshly created fixture DB. The worker performs no network I/O. */
export async function lockFixture(path: string, releaseAfterMs = 0) {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.path);
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    let released = false;
    function release() {
      if (released) return; released = true;
      db.exec("ROLLBACK"); db.close(); parentPort.close();
    }
    parentPort.on("message", release);
    if (workerData.releaseAfterMs) setTimeout(release, workerData.releaseAfterMs).unref();
    parentPort.postMessage("locked");
  `,
    { eval: true, execArgv: [], workerData: { path, releaseAfterMs } },
  );
  try {
    await once(worker, "message");
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  return worker;
}
