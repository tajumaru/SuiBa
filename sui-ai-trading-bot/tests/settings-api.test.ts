import { it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BotDatabase } from "../packages/database/src/index.ts";
import { applySafePreset } from "../apps/dashboard/src/settingsPresets.ts";

it("keeps PAPER settings, history and stop gates through the real API and restart", async () => {
  const folder = mkdtempSync(join(tmpdir(), "suiba-settings-")),
    database = join(folder, "test.sqlite");
  const token = randomBytes(32).toString("hex");
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const seed = new BotDatabase(database);
  const original = {
    ...seed.settings(),
    dailyLossPct: 0.002,
    maxHoldingRatio: 0.08,
    stopLossPct: 0.017,
  };
  seed.updateSettings(original);
  seed.append("paper_trades", "old-trade", {
    orderId: "old-trade",
    timestamp: 1,
  });
  seed.set("runtime", { ...seed.runtime(), running: true, emergency: true });
  seed.close();
  let child: ChildProcess | undefined;
  let failure = "";
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const stopped = new Promise<void>((resolve) =>
      child!.once("exit", () => resolve()),
    );
    child.kill();
    await stopped;
  }
  async function start() {
    child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/worker/src/index.ts"],
      {
        env: {
          ...process.env,
          MODE: "PAPER",
          ADMIN_TOKEN: token,
          PORT: String(port),
          HOST: "127.0.0.1",
          DATABASE_PATH: database,
          SUI_GRPC_URL: "https://127.0.0.1:1",
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    child.stderr?.on("data", (chunk) => {
      failure += String(chunk);
    });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null)
        throw new Error("Test worker exited: " + failure);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/state`)).status === 401)
          return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Test worker did not start");
  }
  async function api(path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, value: await response.json() };
  }
  try {
    await start();
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", mode: "PAPER" });
    const healthProcess = spawn(process.execPath, ["docker/healthcheck.mjs"], {
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
      windowsHide: true,
    });
    expect(
      await new Promise<number | null>((resolve, reject) => {
        healthProcess.once("exit", resolve);
        healthProcess.once("error", reject);
      }),
    ).toBe(0);
    expect(
      (await fetch(`http://127.0.0.1:${port}/api/operations`)).status,
    ).toBe(401);
    const monitoring = await api("operations");
    expect(monitoring.status).toBe(200);
    expect(monitoring.value.status).toBe("ABNORMAL_STOP");
    expect(monitoring.value.reports).toHaveLength(2);
    let state = (await api("state")).value;
    expect(state.mode).toBe("PAPER");
    expect(state.runtime).toMatchObject({ running: false, emergency: true });
    expect(state.settings).toEqual(original);
    const safe = applySafePreset(state.settings);
    expect((await api("settings", safe)).status).toBe(200);
    state = (await api("state")).value;
    expect(state.settings).toEqual(safe);
    expect(state.runtime.running).toBe(false);
    expect(state.trades).toHaveLength(1);
    expect((await api("settings", { ...safe, maxOrder: 6 })).status).toBe(400);
    expect((await api("state")).value.settings).toEqual(safe);
    expect((await api("control", { command: "start" })).status).toBe(409);
    expect((await api("control", { command: "stop" })).value.running).toBe(
      false,
    );
    expect((await api("control", { command: "reset" })).value).toMatchObject({
      running: false,
      emergency: false,
      error: null,
    });
    // Unhealthy connections must still prevent a start after a manual reset.
    expect((await api("control", { command: "start" })).status).toBe(409);
    expect(
      (await api("control", { command: "emergency" })).value,
    ).toMatchObject({ running: false, emergency: true });
    await stop();
    await start();
    state = (await api("state")).value;
    expect(
      (await api("operations")).value.events.some(
        (event: { code: string }) => event.code === "PROCESS_RESTART_STOPPED",
      ),
    ).toBe(true);
    expect(state.runtime).toMatchObject({ running: false, emergency: true });
    expect(state.settings).toEqual(safe);
    expect(state.trades).toHaveLength(1);
    expect(state.trades[0].orderId).toBe("old-trade");
  } finally {
    await stop();
    rmSync(folder, { recursive: true, force: true });
  }
}, 20000);
