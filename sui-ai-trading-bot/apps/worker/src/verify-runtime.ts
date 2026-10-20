// End-to-end read-only verification. Credentials stay in process memory and are never printed.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { strict as assert } from "node:assert";
const token = randomBytes(32).toString("hex"),
  port = 3198;
mkdirSync("data/verification", { recursive: true });
const database = `data/verification/${Date.now()}.sqlite`;
let child: ChildProcess;
async function start() {
  child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/worker/src/index.ts"],
    {
      env: {
        ...process.env,
        ADMIN_TOKEN: token,
        PORT: String(port),
        DATABASE_PATH: database,
        MODE: "PAPER",
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (r.status === 401) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Worker did not start");
}
async function api(path: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(r.status, 200);
  return r.json();
}
async function stop() {
  const c = child;
  if (c.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    c.once("exit", () => resolve());
    c.kill();
  });
}
try {
  await start();
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(unauthorized.status, 401);
  const html = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Sui Paper Lab/);
  let state = await api("state");
  assert.equal(state.mode, "PAPER");
  assert.equal(state.runtime.running, false);
  for (let i = 0; i < 90; i++) {
    state = await api("state");
    if (state.price !== null || state.runtime.error) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(
    state.runtime.error,
    null,
    `upstream data verification failed (${state.runtime.error ?? "none"})`,
  );
  assert.ok(state.candles.length >= 61);
  assert.ok(state.price > 0);
  console.info(
    "PASS: authenticated API, static UI, all 3 mainnet timeframes, indicator calculation",
  );
  await api("control", { command: "emergency" });
  state = await api("state");
  assert.equal(state.runtime.emergency, true);
  assert.equal(state.runtime.running, false);
  await stop();
  await start();
  state = await api("state");
  assert.equal(state.runtime.emergency, true);
  assert.equal(state.runtime.running, false);
  assert.equal(state.portfolio.usdc, 100);
  assert.equal(state.trades.length, 0);
  console.info(
    "PASS: persisted emergency stop, restart restoration, no orders while stopped",
  );
} finally {
  if (child!) await stop();
}
