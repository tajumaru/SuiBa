import { expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  packageLinuxRelease,
  verifyLinuxRelease,
} from "../apps/worker/src/linux-release-artifact.ts";
import {
  LinuxPaperRelease,
  type ServiceControl,
} from "../apps/worker/src/linux-paper-release.ts";

it.skipIf(process.platform !== "linux")(
  "actual loopback Linux release uses packaged workers and preserves PAPER history through cutover and rollback",
  async () => {
    const folder = mkdtempSync(join(tmpdir(), "suiba-release-process-"));
    const oldSha = "1".repeat(40),
      newSha = "2".repeat(40);
    const releases = join(folder, "releases"),
      state = join(folder, "state"),
      database = join(folder, "data", "bot.sqlite"),
      backups = join(folder, "backups"),
      key = join(folder, "key");
    for (const dir of [releases, state, join(folder, "data"), backups])
      mkdirSync(dir);
    let child: ChildProcess | undefined;
    const stop = async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 30000);
      try {
        const [code] = await exited;
        if (code !== 0) throw Error("FIXTURE_UNCLEAN_STOP");
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      packageLinuxRelease(process.cwd(), join(releases, oldSha), oldSha);
      cpSync(join(releases, oldSha), join(releases, newSha), {
        recursive: true,
        verbatimSymlinks: true,
      });
      const manifest = JSON.parse(
        readFileSync(join(releases, newSha, "release.json"), "utf8"),
      );
      manifest.sha = newSha;
      writeFileSync(
        join(releases, newSha, "release.json"),
        JSON.stringify(manifest),
      );
      verifyLinuxRelease(join(releases, newSha), newSha);
      symlinkSync(join(releases, oldSha), join(state, "current"));
      writeFileSync(key, randomBytes(32), { mode: 0o600 });
      for (const path of [database, database + ".pairs.sqlite"]) {
        const db = new BotDatabase(path);
        db.set("runtime", { ...db.runtime(), running: false, emergency: true });
        db.append("paper_trades", "preserved", { timestamp: 1 });
        db.close();
      }
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((r) => probe.close(() => r()));
      const token = randomBytes(32).toString("hex"),
        origin = `http://127.0.0.1:${port}`;
      const service: ServiceControl = {
        stop,
        async stopped() {
          return !child || child.exitCode !== null || child.signalCode !== null;
        },
        async start() {
          const current = join(state, "current"),
            release = JSON.parse(
              readFileSync(join(current, "release.json"), "utf8"),
            );
          child = spawn(
            process.execPath,
            [
              "--import",
              "./scripts/enforce-node-version.mjs",
              "--import",
              "tsx",
              "apps/worker/src/index.ts",
            ],
            {
              cwd: current,
              env: {
                ...process.env,
                MODE: "PAPER",
                HOST: "127.0.0.1",
                PORT: String(port),
                DATABASE_PATH: database,
                REQUIRE_EXISTING_DATABASE: "1",
                ADMIN_TOKEN_FILE: "",
                ADMIN_TOKEN: token,
                SUIBA_BUILD_SHA: release.sha,
                SUI_GRPC_URL: "https://127.0.0.1:1",
                MARKET_DATA_PROVIDER: "deepbook",
                TRADING_PAIR: "SUI_USDC",
                DOTENV_CONFIG_PATH: "/dev/null",
                DOTENV_CONFIG_QUIET: "true",
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
        },
        async probe() {
          for (let i = 0; i < 100; i++) {
            if (child?.exitCode !== null) throw Error("FIXTURE_WORKER_EXITED");
            try {
              const denied = await fetch(origin + "/api/deployment", {
                signal: AbortSignal.timeout(2000),
              });
              await denied.body?.cancel();
              expect(denied.status).toBe(401);
              const response = await fetch(origin + "/api/deployment", {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(2000),
              });
              if (response.ok)
                return (await response.json()) as Awaited<
                  ReturnType<ServiceControl["probe"]>
                >;
              await response.body?.cancel();
            } catch {}
            await new Promise((r) => setTimeout(r, 100));
          }
          throw Error("FIXTURE_PROBE_TIMEOUT");
        },
      };
      await service.start();
      expect((await service.probe()).running).toBe(false);
      const manager = new LinuxPaperRelease(
        { releases, state, database, backups, key },
        service,
        false,
      );
      const transaction = await manager.prepare(newSha);
      await manager.activate(transaction, true);
      expect((await service.probe()).revision).toBe(newSha);
      await manager.rollback(transaction);
      expect((await service.probe()).revision).toBe(oldSha);
      await manager.unlock(transaction);
      expect(await service.probe()).toMatchObject({
        mode: "PAPER",
        running: false,
        maintenance: false,
        revision: oldSha,
        ledgerOk: true,
      });
      expect(existsSync(join(backups, transaction, "COMPLETE"))).toBe(true);
      await stop();
      const db = new BotDatabase(database);
      expect(db.history("paper_trades")).toHaveLength(1);
      expect(db.runtime().emergency).toBe(true);
      db.close();
    } finally {
      try {
        await stop();
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    }
  },
  120000,
);
