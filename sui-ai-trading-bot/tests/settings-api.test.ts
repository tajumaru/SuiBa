import { ChartHistoryStore } from "../apps/worker/src/chart-history.ts";
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
  const chartTo = Math.floor(Date.now() / 300000) * 300,
    chartFrom = chartTo - 600;
  const cache = new ChartHistoryStore(database + ".chart-history.sqlite", {
    fetch: async () =>
      Response.json({ candles: [[(chartTo - 600) * 1000, 2, 3, 1, 2, 0]] }),
    now: Date.now,
    sleep: async () => {},
    gate: async () => true,
  });
  await cache.get({ timeframe: 300, from: chartFrom, to: chartTo });
  cache.close();
  try {
    await start();
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers.get("server-timing")).toMatch(
      /sql;dur=[\d.]+, sql-count;desc="\d+", aggregate;dur=[\d.]+, json;dur=[\d.]+, compression;dur=0\.000/,
    );
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
    for (const path of [
      "dashboard/summary",
      "dashboard/candles?timeframe=300",
      "dashboard/records",
    ])
      expect((await fetch(`http://127.0.0.1:${port}/api/${path}`)).status).toBe(
        401,
      );
    const summary = await api("dashboard/summary");
    expect(summary.value.schema).toBe(1);
    expect(summary.value.summary.runtime).toMatchObject({
      running: false,
      emergency: true,
    });
    expect(summary.value.summary.candles).toBeUndefined();
    expect((await api("dashboard/candles?timeframe=60")).status).toBe(400);
    const frame = (await api("dashboard/candles?timeframe=300")).value;
    expect(frame.reset).toBe(true);
    expect(
      (await api("dashboard/candles?timeframe=300&version=" + frame.version))
        .value.upserts,
    ).toEqual([]);
    const zipped = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip" },
    });
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect((await zipped.json()).runtime.emergency).toBe(true);
    const plain = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Accept-Encoding": "gzip;q=0",
      },
    });
    expect(plain.headers.get("content-encoding")).toBeNull();
    let state = (await api("state")).value;
    expect(state.mode).toBe("PAPER");
    expect(state.runtime).toMatchObject({ running: false, emergency: true });
    expect(state.settings).toEqual(original);
    const beforeChart = {
      runtime: state.runtime,
      settings: state.settings,
      trades: state.trades,
    };
    const historyPath = `chart/history?timeframe=300&from=${chartFrom}&to=${chartTo}`;
    expect(
      (await fetch(`http://127.0.0.1:${port}/api/${historyPath}`)).status,
    ).toBe(401);
    expect((await api("chart/history?timeframe=60&from=1&to=2")).status).toBe(
      400,
    );
    const chartResult = await api(historyPath);
    expect(chartResult.status).toBe(200);
    expect(chartResult.value.cacheHit).toBe(true);
    expect(chartResult.value.candles).toHaveLength(1);
    const afterChart = (await api("state")).value;
    expect({
      runtime: afterChart.runtime,
      settings: afterChart.settings,
      trades: afterChart.trades,
    }).toEqual(beforeChart);
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
    const diagnostic = failure
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === "UPSTREAM_REQUEST_FAILED");
    expect(diagnostic).toMatchObject({
      api: "Sui gRPC",
      host: "127.0.0.1:1",
      operation: "SUI_GRPC_READ",
      code: "UPSTREAM_NETWORK_FAILED",
      phase: "HEADERS_OR_CONNECT",
    });
    expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(diagnostic.url).toBe("https://127.0.0.1:1/[redacted]");
    expect(failure).not.toContain(token);
  } finally {
    await stop();
    rmSync(folder, { recursive: true, force: true });
  }
}, 20000);
