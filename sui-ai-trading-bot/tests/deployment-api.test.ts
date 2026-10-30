import { expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { acquireInstanceLock } from "../apps/worker/src/deployment-safety.ts";
import { createPaperBackup } from "../apps/worker/src/paper-backup.ts";

it("actual loopback deployment maintenance rejects changes and duplicate workers; Linux shutdown proves a stopped backup", async () => {
  const folder = mkdtempSync(join(tmpdir(), "suiba-deployment-api-")),
    root = join(folder, "bot.sqlite");
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const token = randomBytes(32).toString("hex"),
    base = `http://127.0.0.1:${port}`;
  const children: ChildProcess[] = [];
  const start = (workerPort: number) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/worker/src/index.ts"],
      {
        env: {
          ...process.env,
          MODE: "PAPER",
          ADMIN_TOKEN: token,
          ADMIN_TOKEN_FILE: "",
          PORT: String(workerPort),
          HOST: "127.0.0.1",
          DATABASE_PATH: root,
          SUI_GRPC_URL: "https://127.0.0.1:1",
          MARKET_DATA_PROVIDER: "deepbook",
          DOTENV_CONFIG_QUIET: "true",
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    children.push(child);
    return child;
  };
  const request = (path: string, body?: unknown, authenticated = true) =>
    fetch(base + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  const terminate = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  };
  try {
    const worker = start(port);
    let ready = false;
    for (let i = 0; i < 300; i++) {
      if (worker.exitCode !== null) throw Error("FIXTURE_WORKER_EXITED");
      try {
        if ((await request("deployment", undefined, false)).status === 401) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(ready).toBe(true);
    expect(await (await request("deployment")).json()).toMatchObject({
      mode: "PAPER",
      maintenance: false,
    });
    const duplicate = start(0);
    let duplicateError = "";
    duplicate.stderr!.on("data", (d) => {
      duplicateError += String(d);
    });
    const [code] = await once(duplicate, "exit");
    expect(code).not.toBe(0);
    expect(duplicateError).toContain("INSTANCE_LOCK_UNAVAILABLE");
    writeFileSync(root + ".maintenance", "");
    expect(await (await request("deployment")).json()).toMatchObject({
      maintenance: true,
    });
    for (const [path, body] of [
      ["control", { command: "start" }],
      ["control", { command: "reset" }],
      ["settings", {}],
      ["pairs", { pair: "WAL_USDC" }],
      ["backtest", {}],
      ["validation/start", {}],
    ] as const) {
      const res = await request(path, body);
      expect(res.status, path).toBe(409);
      expect(await res.json()).toEqual({ error: "DEPLOYMENT_MAINTENANCE" });
    }
    expect((await request("control", { command: "start" }, false)).status).toBe(
      401,
    );
    expect((await request("control", { command: "emergency" })).status).toBe(
      200,
    );
    expect((await request("control", { command: "stop" })).status).toBe(200);
    expect(() => acquireInstanceLock(root)).toThrow(
      "INSTANCE_LOCK_UNAVAILABLE",
    );
    if (process.platform !== "win32") {
      const exited = once(worker, "exit");
      worker.kill("SIGTERM");
      expect((await exited)[0]).toBe(0);
      expect(
        JSON.parse(readFileSync(root + ".lifecycle.json", "utf8")),
      ).toMatchObject({ mode: "PAPER", state: "clean" });
      const manifest = await createPaperBackup(root, join(folder, "backup"));
      expect(manifest.databases).toHaveLength(2);
    } else {
      // Windows child.kill is forced termination, not POSIX graceful SIGTERM.
      await terminate(worker);
      expect(
        JSON.parse(readFileSync(root + ".lifecycle.json", "utf8")),
      ).toMatchObject({ state: "running" });
      await expect(
        createPaperBackup(root, join(folder, "backup")),
      ).rejects.toThrow("BACKUP_REQUIRES_CLEAN_SHUTDOWN");
    }
  } finally {
    for (const child of children) await terminate(child);
    rmSync(folder, { recursive: true, force: true });
  }
}, 45000);
