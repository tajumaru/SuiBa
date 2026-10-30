import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { acquireInstanceLock } from "./deployment-safety.ts";
import { createPaperBackup, verifyPaperBackup } from "./paper-backup.ts";
import {
  encryptPaperBackup,
  decryptPaperBackup,
} from "./encrypted-paper-backup.ts";
import { existingPaperDatabases } from "./paper-database-inventory.ts";
import {
  fileHash,
  revision,
  sha256,
  verifyLinuxRelease,
  type ReleaseManifest,
} from "./linux-release-artifact.ts";

export interface ReleaseLayout {
  releases: string;
  state: string;
  database: string;
  backups: string;
  key: string;
}
export interface ServiceControl {
  stop(): Promise<void>;
  stopped(): Promise<boolean>;
  start(): Promise<void>;
  probe(): Promise<{
    mode: string;
    maintenance: boolean;
    running: boolean;
    revision: string | null;
    lockSha256: string | null;
    databaseHealthy: boolean;
    ledgerOk: boolean;
  }>;
}
type Proof = Record<string, { schema: string; ledger: string }>;
type Transaction = {
  version: 1;
  id: string;
  phase:
    | "STOPPING"
    | "PREPARED"
    | "ACTIVATING"
    | "VERIFIED"
    | "UNLOCKING"
    | "COMPLETED"
    | "ROLLING_BACK"
    | "ROLLED_BACK"
    | "CANCELLED"
    | "FAILED";
  from: string;
  to: string;
  fromManifest: string;
  toManifest: string;
  proof?: Proof;
  archive?: string;
  failure?: string;
};

function sync(path: string, directory = false) {
  const fd = openSync(path, directory ? "r" : "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function atomicJson(path: string, value: unknown) {
  const temp = path + "." + randomUUID();
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  sync(temp);
  renameSync(temp, path);
  if (process.platform === "linux") sync(dirname(path), true);
}
function id(value: string) {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw Error("INVALID_DEPLOYMENT_ID");
  return value;
}
function databaseProof(root: string): Proof {
  const names = existingPaperDatabases(dirname(root), basename(root)),
    proof: Proof = {};
  for (const name of names) {
    const db = new DatabaseSync(join(dirname(root), name), { readOnly: true });
    try {
      const schema = db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all();
      const hash = (rows: Iterable<unknown>) => {
        let value = "";
        for (const row of rows) value = sha256(value + JSON.stringify(row));
        return value;
      };
      let ledger = "";
      if (
        name === basename(root) ||
        name === basename(root) + ".WAL_USDC.sqlite"
      ) {
        const runtime = JSON.parse(
          String(
            db
              .prepare("SELECT json FROM bot_runtime_state WHERE key='runtime'")
              .get()?.json,
          ),
        );
        if (runtime.running !== false)
          throw Error("DEPLOYMENT_REQUIRES_STOPPED_PAPER");
        ledger = hash(
          db
            .prepare(
              "SELECT key,json FROM bot_runtime_state WHERE key IN ('portfolio','settings','profitGuard') ORDER BY key",
            )
            .iterate(),
        );
        ledger = sha256(
          ledger +
            JSON.stringify({
              emergency: runtime.emergency,
              error: runtime.error,
              lastCandle: runtime.lastCandle,
            }),
        );
        for (const table of [
          "paper_trades",
          "paper_orders",
          "paper_checks",
          "portfolio_snapshots",
          "bot_settings",
          "profit_assessments",
        ])
          ledger = sha256(
            ledger +
              hash(
                db
                  .prepare(`SELECT id,timestamp,json FROM ${table} ORDER BY id`)
                  .iterate(),
              ),
          );
      } else if (name.endsWith(".pairs.sqlite"))
        ledger = hash(
          db
            .prepare(
              "SELECT key,json FROM bot_runtime_state WHERE key='selected_pair'",
            )
            .iterate(),
        );
      proof[name] = { schema: sha256(JSON.stringify(schema)), ledger };
    } finally {
      db.close();
    }
  }
  return proof;
}
function sameProof(a: Proof, b: Proof) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Host-only orchestration. Production CLI fixes all paths/service commands;
 * tests inject an isolated layout and a non-privileged process service driver.
 * No source/release code runs as root, no DB migration/restore/start-of-trading.
 */
export class LinuxPaperRelease {
  constructor(
    private layout: ReleaseLayout,
    private service: ServiceControl,
    private rootOwned = true,
  ) {}
  private file(idValue: string) {
    return join(this.layout.state, id(idValue) + ".json");
  }
  private release(sha: string) {
    return join(this.layout.releases, revision(sha));
  }
  private current() {
    const link = join(this.layout.state, "current"),
      target = realpathSync(link),
      sha = basename(target);
    if (
      !lstatSync(link).isSymbolicLink() ||
      target !== realpathSync(this.release(sha))
    )
      throw Error("INVALID_CURRENT_RELEASE");
    return revision(sha);
  }
  private checked(sha: string) {
    return verifyLinuxRelease(this.release(sha), sha, this.rootOwned);
  }
  private manifestHash(sha: string) {
    return fileHash(join(this.release(sha), "release.json"));
  }
  private switchTo(sha: string) {
    const temp = join(this.layout.state, ".current-" + randomUUID());
    symlinkSync(this.release(sha), temp);
    renameSync(temp, join(this.layout.state, "current"));
    sync(this.layout.state, true);
  }
  private latch() {
    try {
      writeFileSync(
        this.layout.database + ".maintenance",
        "PAPER deployment maintenance\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    sync(this.layout.database + ".maintenance");
    sync(dirname(this.layout.database), true);
  }
  private async stopped() {
    if (!(await this.service.stopped())) throw Error("SERVICE_STILL_ACTIVE");
    const lock = acquireInstanceLock(this.layout.database);
    lock.close();
  }
  private async locked<T>(run: () => Promise<T>) {
    if (process.platform !== "linux") throw Error("LINUX_RELEASE_REQUIRED");
    mkdirSync(this.layout.state, { recursive: true, mode: 0o700 });
    const lock = new DatabaseSync(
      join(this.layout.state, "deployment-lock.sqlite"),
    );
    try {
      lock.exec(
        "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE",
      );
    } catch {
      lock.close();
      throw Error("DEPLOYMENT_ALREADY_ACTIVE");
    }
    try {
      return await run();
    } finally {
      lock.close();
    }
  }
  private read(transaction: string) {
    const path = this.file(transaction),
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
      throw Error("INVALID_DEPLOYMENT_STATE");
    const value = JSON.parse(readFileSync(path, "utf8")) as Transaction;
    if (value.version !== 1 || value.id !== transaction)
      throw Error("INVALID_DEPLOYMENT_STATE");
    revision(value.from);
    revision(value.to);
    return value;
  }
  private revalidate(tx: Transaction) {
    const from = this.checked(tx.from),
      to = this.checked(tx.to);
    if (
      from.databaseContract !== to.databaseContract ||
      this.manifestHash(tx.from) !== tx.fromManifest ||
      this.manifestHash(tx.to) !== tx.toManifest
    )
      throw Error("RELEASE_CHANGED_SINCE_PREPARE");
    return to;
  }
  private async verify(
    sha: string,
    manifest: ReleaseManifest,
    maintenance: boolean,
  ) {
    const probe = await this.service.probe();
    if (
      probe.mode !== "PAPER" ||
      probe.running !== false ||
      probe.maintenance !== maintenance ||
      probe.revision !== sha ||
      probe.lockSha256 !==
        fileHash(join(this.release(sha), "pnpm-lock.yaml")) ||
      probe.databaseHealthy !== true ||
      probe.ledgerOk !== true ||
      manifest.mode !== "PAPER"
    )
      throw Error("RELEASE_PROBE_FAILED");
  }
  private async fail(tx: Transaction) {
    try {
      this.latch();
    } catch {
      /* Even disk failure must attempt a service stop. */
    }
    try {
      await this.service.stop();
      await this.stopped();
    } finally {
      tx.phase = "FAILED";
      tx.failure = "DEPLOYMENT_FAILED_STOPPED_REVIEW_REQUIRED";
      atomicJson(this.file(tx.id), tx);
    }
  }
  async prepare(target: string) {
    return this.locked(async () => {
      const from = this.current(),
        old = this.checked(from),
        next = this.checked(target);
      if (from === target || old.databaseContract !== next.databaseContract)
        throw Error("INCOMPATIBLE_DEPLOYMENT");
      // Do not hide an interrupted/unfinished transaction behind a new one.
      const activePath = join(this.layout.state, "active.json");
      let active: { id: string } | undefined;
      try {
        active = JSON.parse(readFileSync(activePath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        active &&
        !["COMPLETED", "ROLLED_BACK", "CANCELLED"].includes(
          this.read(active.id).phase,
        )
      )
        throw Error("UNFINISHED_DEPLOYMENT");
      const tx: Transaction = {
        version: 1,
        id: randomUUID(),
        phase: "STOPPING",
        from,
        to: target,
        fromManifest: this.manifestHash(from),
        toManifest: this.manifestHash(target),
      };
      atomicJson(this.file(tx.id), tx);
      atomicJson(activePath, { id: tx.id });
      try {
        this.latch();
        await this.service.stop();
        await this.stopped();
        const stage = join(this.layout.state, tx.id + "-plain"),
          check = join(this.layout.state, tx.id + "-check");
        const archive = join(this.layout.backups, tx.id);
        const snapshot = await createPaperBackup(this.layout.database, stage);
        tx.proof = databaseProof(this.layout.database);
        await encryptPaperBackup(stage, archive, this.layout.key);
        await decryptPaperBackup(archive, check, this.layout.key);
        verifyPaperBackup(check);
        if (!sameProof(tx.proof, databaseProof(join(check, snapshot.rootName))))
          throw Error("BACKUP_LEDGER_MISMATCH");
        rmSync(stage, { recursive: true });
        rmSync(check, { recursive: true });
        tx.archive = tx.id;
        tx.phase = "PREPARED";
        atomicJson(this.file(tx.id), tx);
        return tx.id;
      } catch (error) {
        await this.fail(tx);
        throw error;
      }
    });
  }
  async activate(transaction: string, offHostConfirmed: boolean) {
    return this.locked(async () => {
      const tx = this.read(transaction);
      if (
        tx.phase !== "PREPARED" ||
        this.current() !== tx.from ||
        !offHostConfirmed
      )
        throw Error("DEPLOYMENT_APPROVAL_REQUIRED");
      const manifest = this.revalidate(tx);
      try {
        await this.stopped();
        this.latch();
        if (
          !tx.proof ||
          !sameProof(tx.proof, databaseProof(this.layout.database))
        )
          throw Error("DATABASE_CHANGED_SINCE_PREPARE");
        const check = join(this.layout.state, tx.id + "-activate-check");
        await decryptPaperBackup(
          join(this.layout.backups, tx.id),
          check,
          this.layout.key,
        );
        const restored = verifyPaperBackup(check);
        if (!sameProof(tx.proof, databaseProof(join(check, restored.rootName))))
          throw Error("BACKUP_LEDGER_MISMATCH");
        rmSync(check, { recursive: true });
        tx.phase = "ACTIVATING";
        atomicJson(this.file(tx.id), tx);
        this.switchTo(tx.to);
        await this.service.start();
        await this.verify(tx.to, manifest, true);
        if (!sameProof(tx.proof, databaseProof(this.layout.database)))
          throw Error("DEPLOYMENT_LEDGER_CHANGED");
        tx.phase = "VERIFIED";
        atomicJson(this.file(tx.id), tx);
      } catch (error) {
        await this.fail(tx);
        throw error;
      }
    });
  }
  async unlock(transaction: string) {
    return this.locked(async () => {
      const tx = this.read(transaction);
      const returning = ["ROLLED_BACK", "CANCELLED"].includes(tx.phase);
      const active = returning ? tx.from : tx.to;
      if (
        !["VERIFIED", "ROLLED_BACK", "CANCELLED"].includes(tx.phase) ||
        this.current() !== active
      )
        throw Error("UNVERIFIED_DEPLOYMENT");
      if (!returning) this.revalidate(tx);
      else if (this.manifestHash(tx.from) !== tx.fromManifest)
        throw Error("RELEASE_CHANGED_SINCE_PREPARE");
      const manifest = this.checked(active);
      try {
        tx.phase = "UNLOCKING";
        atomicJson(this.file(tx.id), tx);
        await this.service.stop();
        await this.stopped();
        if (
          !tx.proof ||
          !sameProof(tx.proof, databaseProof(this.layout.database))
        )
          throw Error("DEPLOYMENT_LEDGER_CHANGED");
        unlinkSync(this.layout.database + ".maintenance");
        sync(dirname(this.layout.database), true);
        await this.service.start();
        await this.verify(active, manifest, false);
        tx.phase = "COMPLETED";
        atomicJson(this.file(tx.id), tx);
      } catch (error) {
        await this.fail(tx);
        throw error;
      }
    });
  }
  async rollback(transaction: string) {
    return this.locked(async () => {
      const tx = this.read(transaction);
      if (
        !["PREPARED", "VERIFIED", "FAILED", "ACTIVATING", "UNLOCKING"].includes(
          tx.phase,
        ) ||
        ![tx.from, tx.to].includes(this.current())
      )
        throw Error("ROLLBACK_REQUIRES_REVIEW");
      this.revalidate(tx);
      try {
        this.latch();
        await this.service.stop();
        await this.stopped();
        const receipt = JSON.parse(
          readFileSync(this.layout.database + ".lifecycle.json", "utf8"),
        );
        if (
          receipt.state !== "clean" ||
          !tx.proof ||
          !sameProof(tx.proof, databaseProof(this.layout.database))
        )
          throw Error("ROLLBACK_DATABASE_INCOMPATIBLE");
        tx.phase = "ROLLING_BACK";
        atomicJson(this.file(tx.id), tx);
        this.switchTo(tx.from);
        await this.service.start();
        await this.verify(tx.from, this.checked(tx.from), true);
        tx.phase = "ROLLED_BACK";
        atomicJson(this.file(tx.id), tx);
      } catch (error) {
        await this.fail(tx);
        throw error;
      }
    });
  }
  status(transaction: string) {
    return this.read(transaction);
  }
  async cancel(transaction: string) {
    return this.locked(async () => {
      const tx = this.read(transaction);
      if (
        !["STOPPING", "PREPARED", "FAILED"].includes(tx.phase) ||
        this.current() !== tx.from
      )
        throw Error("CANNOT_CANCEL_AFTER_CUTOVER");
      this.checked(tx.from);
      if (this.manifestHash(tx.from) !== tx.fromManifest)
        throw Error("RELEASE_CHANGED_SINCE_PREPARE");
      this.latch();
      await this.service.stop();
      await this.stopped();
      const receipt = JSON.parse(
        readFileSync(this.layout.database + ".lifecycle.json", "utf8"),
      );
      if (receipt.state !== "clean")
        throw Error("CANCEL_REQUIRES_CLEAN_SHUTDOWN");
      const proof = databaseProof(this.layout.database);
      if (tx.proof && !sameProof(tx.proof, proof))
        throw Error("DEPLOYMENT_LEDGER_CHANGED");
      tx.proof = proof;
      tx.phase = "CANCELLED";
      atomicJson(this.file(tx.id), tx);
    });
  }
}
