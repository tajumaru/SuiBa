import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  chmodSync,
  rmSync,
  symlinkSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import {
  packageLinuxRelease,
  verifyLinuxRelease,
  fileHash,
} from "../apps/worker/src/linux-release-artifact.ts";
import {
  LinuxPaperRelease,
  type ReleaseLayout,
  type ServiceControl,
} from "../apps/worker/src/linux-paper-release.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { recordLifecycle } from "../apps/worker/src/deployment-safety.ts";

const oldSha = "a".repeat(40),
  newSha = "b".repeat(40);
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
function folder() {
  const result = mkdtempSync(join(tmpdir(), "suiba-release-"));
  folders.push(result);
  return result;
}
function source(root: string) {
  for (const name of [
    "apps/worker/src",
    "packages",
    "scripts",
    "node_modules/tsx",
  ])
    mkdirSync(join(root, name), { recursive: true });
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "tsconfig.json",
    "apps/worker/src/index.ts",
    "scripts/enforce-node-version.mjs",
    "node_modules/tsx/package.json",
  ])
    writeFileSync(
      join(root, name),
      name.endsWith(".json") ? "{}" : "fixture\n",
    );
}
function fixture() {
  const base = folder(),
    src = join(base, "source");
  source(src);
  const layout: ReleaseLayout = {
    releases: join(base, "releases"),
    state: join(base, "control"),
    database: join(base, "data", "bot.sqlite"),
    backups: join(base, "backups"),
    key: join(base, "backup.key"),
  };
  for (const dir of [
    layout.releases,
    layout.state,
    join(base, "data"),
    layout.backups,
  ])
    mkdirSync(dir);
  for (const sha of [oldSha, newSha])
    packageLinuxRelease(src, join(layout.releases, sha), sha);
  symlinkSync(join(layout.releases, oldSha), join(layout.state, "current"));
  writeFileSync(layout.key, randomBytes(32), { mode: 0o600 });
  for (const path of [layout.database, layout.database + ".pairs.sqlite"]) {
    const db = new BotDatabase(path);
    db.set("runtime", { ...db.runtime(), running: false, emergency: true });
    db.set("fixture_guard", { highWater: "100" });
    db.append("paper_trades", "old-history", { timestamp: 1 });
    db.close();
  }
  const fault = {
    badProbe: false,
    schema: false,
    ledger: false,
    checks: false,
    stop: false,
    backup: false,
  };
  let active = true;
  const sha = () =>
    readlinkSync(join(layout.state, "current")).split("/").at(-1)!;
  const service: ServiceControl = {
    async stop() {
      if (fault.stop) throw Error("FIXTURE_STOP_FAILED");
      active = false;
      const db = new BotDatabase(layout.database);
      db.set("runtime", { ...db.runtime(), running: false });
      db.close();
      recordLifecycle(
        layout.database,
        "fixture-boot",
        fault.backup ? "running" : "clean",
      );
    },
    async stopped() {
      return !active;
    },
    async start() {
      active = true;
      const db = new BotDatabase(layout.database);
      new OperationMonitor(db).boot();
      if (fault.ledger)
        db.append("paper_trades", "unexpected", { timestamp: 2 });
      if (fault.checks)
        db.append("paper_checks", "unexpected-check", {
          timestamp: 2,
          ok: true,
        });
      db.close();
      if (fault.schema) {
        const sql = new DatabaseSync(layout.database);
        sql.exec("CREATE TABLE unexpected(value TEXT)");
        sql.close();
      }
      recordLifecycle(layout.database, "fixture-new-boot", "running");
    },
    async probe() {
      return {
        mode: fault.badProbe ? "LIVE" : "PAPER",
        maintenance: existsSync(layout.database + ".maintenance"),
        running: false,
        revision: sha(),
        lockSha256: fileHash(join(layout.releases, sha(), "pnpm-lock.yaml")),
        databaseHealthy: true,
        ledgerOk: true,
      };
    },
  };
  return {
    layout,
    service,
    fault,
    manager: new LinuxPaperRelease(layout, service, false),
    current: sha,
    active: () => active,
  };
}

describe.skipIf(process.platform !== "linux")("Linux PAPER release", () => {
  it("prepares an encrypted backup, requires approval, verifies stopped PAPER and unlocks monitoring only", async () => {
    const t = fixture(),
      transaction = await t.manager.prepare(newSha);
    expect(t.active()).toBe(false);
    expect(t.current()).toBe(oldSha);
    expect(t.manager.status(transaction).phase).toBe("PREPARED");
    expect(existsSync(join(t.layout.backups, transaction, "COMPLETE"))).toBe(
      true,
    );
    expect(
      readdirSync(t.layout.state).some(
        (n) => n.endsWith("-plain") || n.endsWith("-check"),
      ),
    ).toBe(false);
    await expect(t.manager.activate(transaction, false)).rejects.toThrow(
      "DEPLOYMENT_APPROVAL_REQUIRED",
    );
    await t.manager.activate(transaction, true);
    expect(t.current()).toBe(newSha);
    expect(t.manager.status(transaction).phase).toBe("VERIFIED");
    expect(existsSync(t.layout.database + ".maintenance")).toBe(true);
    await t.manager.unlock(transaction);
    expect(t.manager.status(transaction).phase).toBe("COMPLETED");
    expect(existsSync(t.layout.database + ".maintenance")).toBe(false);
    const db = new BotDatabase(t.layout.database);
    expect(db.runtime()).toMatchObject({ running: false, emergency: true });
    expect(db.history("paper_trades")).toHaveLength(1);
    db.close();
  }, 30000);

  it("stops on an invalid probe and rolls code back without rewinding the database", async () => {
    const t = fixture(),
      transaction = await t.manager.prepare(newSha);
    t.fault.badProbe = true;
    await expect(t.manager.activate(transaction, true)).rejects.toThrow(
      "RELEASE_PROBE_FAILED",
    );
    expect(t.active()).toBe(false);
    expect(t.manager.status(transaction).phase).toBe("FAILED");
    t.fault.badProbe = false;
    await t.manager.rollback(transaction);
    expect(t.current()).toBe(oldSha);
    expect(t.manager.status(transaction).phase).toBe("ROLLED_BACK");
    const db = new BotDatabase(t.layout.database);
    expect(db.history("paper_trades")).toHaveLength(1);
    expect(db.runtime().emergency).toBe(true);
    db.close();
    await t.manager.unlock(transaction);
    expect(t.manager.status(transaction).phase).toBe("COMPLETED");
  }, 30000);

  it.each(["schema", "ledger", "checks"] as const)(
    "refuses rollback after unexpected %s changes and preserves forensic data",
    async (kind) => {
      const t = fixture(),
        transaction = await t.manager.prepare(newSha);
      t.fault[kind] = true;
      await expect(t.manager.activate(transaction, true)).rejects.toThrow(
        "DEPLOYMENT_LEDGER_CHANGED",
      );
      t.fault[kind] = false;
      await expect(t.manager.rollback(transaction)).rejects.toThrow(
        "ROLLBACK_DATABASE_INCOMPATIBLE",
      );
      expect(t.active()).toBe(false);
      expect(t.current()).toBe(newSha);
      if (kind === "ledger") {
        const db = new BotDatabase(t.layout.database);
        expect(db.history("paper_trades")).toHaveLength(2);
        db.close();
      }
    },
    30000,
  );

  it("does not cut over after unclean shutdown or a corrupted encrypted backup", async () => {
    const t = fixture();
    t.fault.backup = true;
    await expect(t.manager.prepare(newSha)).rejects.toThrow(
      "BACKUP_REQUIRES_CLEAN_SHUTDOWN",
    );
    expect(t.current()).toBe(oldSha);
    expect(t.active()).toBe(false);
    const active = JSON.parse(
      readFileSync(join(t.layout.state, "active.json"), "utf8"),
    );
    t.fault.backup = false;
    await t.manager.cancel(active.id);
    const transaction = await t.manager.prepare(newSha);
    writeFileSync(join(t.layout.backups, transaction, "db-0.enc"), "broken");
    await expect(t.manager.activate(transaction, true)).rejects.toThrow();
    expect(t.current()).toBe(oldSha);
    expect(t.active()).toBe(false);
    await t.manager.cancel(transaction);
    expect(t.manager.status(transaction).phase).toBe("CANCELLED");
  }, 30000);

  it("serializes commands and rejects missing transaction records and old approvals", async () => {
    const t = fixture();
    let release!: () => void;
    const original = t.service.stop;
    t.service.stop = async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      await original();
    };
    const pending = t.manager.prepare(newSha);
    await expect(t.manager.prepare(newSha)).rejects.toThrow(
      "DEPLOYMENT_ALREADY_ACTIVE",
    );
    release();
    t.service.stop = original;
    const transaction = await pending;
    await expect(t.manager.prepare(newSha)).rejects.toThrow(
      "UNFINISHED_DEPLOYMENT",
    );
    await t.manager.cancel(transaction);
    await expect(t.manager.activate(transaction, true)).rejects.toThrow(
      "DEPLOYMENT_APPROVAL_REQUIRED",
    );
    writeFileSync(
      join(t.layout.state, "active.json"),
      JSON.stringify({ id: "c".repeat(36) }),
    );
    await expect(t.manager.prepare(newSha)).rejects.toThrow();
  }, 30000);

  it("refuses cutover when service stop fails and retains the maintenance latch", async () => {
    const t = fixture();
    t.fault.stop = true;
    await expect(t.manager.prepare(newSha)).rejects.toThrow(
      "FIXTURE_STOP_FAILED",
    );
    expect(t.current()).toBe(oldSha);
    expect(existsSync(t.layout.database + ".maintenance")).toBe(true);
    expect(readdirSync(t.layout.backups)).toHaveLength(0);
    const active = JSON.parse(
      readFileSync(join(t.layout.state, "active.json"), "utf8"),
    );
    expect(t.manager.status(active.id).phase).toBe("FAILED");
  }, 30000);

  it("refuses a DB changed after prepare and does not erase the new history", async () => {
    const t = fixture(),
      transaction = await t.manager.prepare(newSha);
    const db = new BotDatabase(t.layout.database);
    db.append("paper_trades", "concurrent-history", { timestamp: 3 });
    db.close();
    await expect(t.manager.activate(transaction, true)).rejects.toThrow(
      "DATABASE_CHANGED_SINCE_PREPARE",
    );
    expect(t.current()).toBe(oldSha);
    const preserved = new BotDatabase(t.layout.database);
    expect(preserved.history("paper_trades")).toHaveLength(2);
    preserved.close();
  }, 30000);

  it("detects release changes, private files, external links and incompatible contracts before service stop", () => {
    const t = fixture();
    writeFileSync(
      join(t.layout.releases, newSha, "apps/worker/src/index.ts"),
      "tampered",
    );
    expect(() =>
      verifyLinuxRelease(join(t.layout.releases, newSha), newSha),
    ).toThrow("RELEASE_CONTENT_CHANGED");
    const executable = join(
      t.layout.releases,
      newSha,
      "apps/worker/src/index.ts",
    );
    chmodSync(executable, 0o4755);
    expect(() =>
      verifyLinuxRelease(join(t.layout.releases, newSha), newSha),
    ).toThrow("RELEASE_SPECIAL_PERMISSIONS");
    chmodSync(executable, 0o644);
    const src = join(folder(), "source");
    source(src);
    writeFileSync(join(src, "apps", ".env"), "fixture only");
    expect(() =>
      packageLinuxRelease(src, join(folder(), "bad"), newSha),
    ).toThrow("RELEASE_PRIVATE_FILE");
    rmSync(join(src, "apps", ".env"));
    symlinkSync("/etc/passwd", join(src, "apps", "outside"));
    expect(() =>
      packageLinuxRelease(src, join(folder(), "external"), newSha),
    ).toThrow("RELEASE_EXTERNAL_LINK");
    const manifest = join(t.layout.releases, oldSha, "release.json");
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    value.databaseContract = "unknown-v2";
    writeFileSync(manifest, JSON.stringify(value));
    expect(() =>
      verifyLinuxRelease(join(t.layout.releases, oldSha), oldSha),
    ).toThrow("INCOMPATIBLE_RELEASE");
  });
});
