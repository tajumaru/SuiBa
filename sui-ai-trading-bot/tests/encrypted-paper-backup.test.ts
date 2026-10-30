import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { BotDatabase } from "../packages/database/src/index.ts";
import { recordLifecycle } from "../apps/worker/src/deployment-safety.ts";
import {
  createPaperBackup,
  verifyPaperBackup,
} from "../apps/worker/src/paper-backup.ts";
import {
  encryptPaperBackup,
  decryptPaperBackup,
} from "../apps/worker/src/encrypted-paper-backup.ts";

const fault = vi.hoisted(() => ({
  ending: "",
  full: false,
  abort: undefined as AbortController | undefined,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const { Writable } = await import("node:stream");
  return {
    ...fs,
    createWriteStream(path: string, options: unknown) {
      if (fault.ending && String(path).endsWith(fault.ending) && fault.full)
        return new Writable({
          write(_chunk, _encoding, callback) {
            callback(
              Object.assign(Error("fixture disk full"), { code: "ENOSPC" }),
            );
          },
        });
      const stream = fs.createWriteStream(
        path,
        options as Parameters<typeof fs.createWriteStream>[1],
      );
      if (fault.ending && String(path).endsWith(fault.ending) && fault.abort)
        stream.once("open", () => fault.abort?.abort());
      return stream;
    },
  };
});

let folder: string, source: string, key: string, archive: string;
let counter = 0;
const next = (name: string) => join(folder, `${name}-${counter++}`);
beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), "suiba-encrypted-"));
  const root = join(folder, "bot.sqlite");
  for (const path of [root, root + ".pairs.sqlite"]) {
    const db = new BotDatabase(path);
    db.set("fixture_guard", { highWater: "1234.56" });
    db.append("paper_trades", "paper-history", {
      timestamp: 1,
      orderId: "paper-history",
    });
    db.close();
  }
  recordLifecycle(root, "fixture", "clean");
  writeFileSync(root + ".maintenance", "");
  source = next("plain");
  await createPaperBackup(root, source);
  key = join(folder, "fixture-key");
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  archive = next("encrypted");
  await encryptPaperBackup(source, archive, key);
}, 30000);
afterEach(() => {
  fault.ending = "";
  fault.full = false;
  fault.abort = undefined;
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

it("round-trips authenticated snapshots with randomized ciphertext and a stopped restore gate", async () => {
  const decoded = next("decoded");
  await decryptPaperBackup(archive, decoded, key);
  const manifest = verifyPaperBackup(decoded);
  expect(manifest.databases).toHaveLength(2);
  expect(existsSync(join(decoded, "bot.sqlite.maintenance"))).toBe(true);
  expect(existsSync(join(decoded, "bot.sqlite.lifecycle.json"))).toBe(false);
  for (const entry of manifest.databases)
    expect(
      readFileSync(join(decoded, entry.name)).equals(
        readFileSync(join(source, entry.name)),
      ),
    ).toBe(true);
  const another = next("encrypted");
  await encryptPaperBackup(source, another, key);
  expect(
    readFileSync(join(archive, "db-0.enc")).equals(
      readFileSync(join(another, "db-0.enc")),
    ),
  ).toBe(false);
  expect(readdirSync(archive).sort()).toEqual([
    "COMPLETE",
    "db-0.enc",
    "db-1.enc",
    "manifest.enc",
  ]);
  expect(
    readFileSync(join(archive, "db-0.enc")).includes(
      Buffer.from("paper-history"),
    ),
  ).toBe(false);
}, 30000);

it("rejects wrong keys and tampered/truncated data without leaving a plaintext result", async () => {
  const wrong = join(folder, "wrong-key");
  writeFileSync(wrong, randomBytes(32), { mode: 0o600 });
  let output = next("wrong-output");
  await expect(decryptPaperBackup(archive, output, wrong)).rejects.toThrow(
    "ENCRYPTED_BACKUP_AUTHENTICATION_FAILED",
  );
  expect(existsSync(output)).toBe(false);
  for (const kind of ["tampered", "truncated"]) {
    const changed = next(kind);
    cpSync(archive, changed, { recursive: true });
    const file = join(changed, "db-0.enc"),
      bytes = readFileSync(file);
    if (kind === "tampered") {
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(file, bytes);
    } else writeFileSync(file, bytes.subarray(0, bytes.length - 1));
    output = next("bad-output");
    await expect(decryptPaperBackup(changed, output, key)).rejects.toThrow();
    expect(existsSync(output)).toBe(false);
  }
}, 30000);

it("rejects swapped data from a different bundle and incomplete archives", async () => {
  const changed = next("swapped");
  await encryptPaperBackup(source, changed, key);
  cpSync(join(archive, "db-0.enc"), join(changed, "db-0.enc"));
  const output = next("swapped-output");
  await expect(decryptPaperBackup(changed, output, key)).rejects.toThrow(
    "ENCRYPTED_BACKUP_AUTHENTICATION_FAILED",
  );
  expect(existsSync(output)).toBe(false);
  rmSync(join(changed, "COMPLETE"));
  await expect(
    decryptPaperBackup(changed, next("incomplete-output"), key),
  ).rejects.toThrow();
}, 30000);

it("preserves existing destinations and refuses co-located or invalid key files", async () => {
  await expect(encryptPaperBackup(source, archive, key)).rejects.toThrow();
  expect(readFileSync(join(archive, "COMPLETE"), "utf8")).toContain(
    "SuiBa encrypted PAPER backup v1",
  );
  await expect(decryptPaperBackup(archive, source, key)).rejects.toThrow();
  expect(verifyPaperBackup(source).databases).toHaveLength(2);
  const inside = join(source, "key");
  cpSync(key, inside);
  chmodSync(inside, 0o600);
  await expect(
    encryptPaperBackup(source, next("key-inside"), inside),
  ).rejects.toThrow("BACKUP_KEY_MUST_BE_SEPARATE");
  const short = join(folder, "short-key");
  writeFileSync(short, "fixture", { mode: 0o600 });
  await expect(
    encryptPaperBackup(source, next("short-key-output"), short),
  ).rejects.toThrow("INVALID_BACKUP_KEY_FILE");
}, 30000);

it("cleans partial outputs after cancellation during encrypt and decrypt writes", async () => {
  for (const operation of ["encrypt", "decrypt"]) {
    const output = next("aborted");
    fault.abort = new AbortController();
    fault.ending = operation === "encrypt" ? "db-0.enc" : ".part";
    await expect(
      operation === "encrypt"
        ? encryptPaperBackup(source, output, key, {
            signal: fault.abort.signal,
          })
        : decryptPaperBackup(archive, output, key, {
            signal: fault.abort.signal,
          }),
    ).rejects.toThrow();
    expect(fault.abort.signal.aborted).toBe(true);
    expect(existsSync(output)).toBe(false);
  }
  expect(verifyPaperBackup(source).databases).toHaveLength(2);
}, 30000);

it("fails safely on injected disk-full errors and leaves the source intact", async () => {
  for (const operation of ["encrypt", "decrypt"]) {
    const output = next("disk-full");
    fault.full = true;
    fault.ending = operation === "encrypt" ? "db-0.enc" : ".part";
    await expect(
      operation === "encrypt"
        ? encryptPaperBackup(source, output, key)
        : decryptPaperBackup(archive, output, key),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(existsSync(output)).toBe(false);
  }
  expect(verifyPaperBackup(source).databases).toHaveLength(2);
}, 30000);

it("exposes encrypt/decrypt through the PAPER-only CLI without revealing key material", () => {
  const encrypted = next("cli-encrypted"),
    decoded = next("cli-decoded");
  const invoke = (mode: string, args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/paper-maintenance.ts", ...args],
      {
        env: { ...process.env, MODE: mode },
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      },
    );
  for (const args of [
    ["encrypt", source, encrypted, key],
    ["decrypt", encrypted, decoded, key],
  ]) {
    const result = invoke("PAPER", args);
    expect(result.status).toBe(0);
    expect(result.stdout.includes("PAPER_MAINTENANCE_OK")).toBe(true);
    expect(result.stdout.includes(readFileSync(key).toString("hex"))).toBe(
      false,
    );
    expect(result.stdout.includes(key)).toBe(false);
  }
  expect(verifyPaperBackup(decoded).databases).toHaveLength(2);
  const result = invoke("LIVE", ["encrypt", source, next("live-refused"), key]);
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe("ONLY_PAPER_SUPPORTED");
}, 30000);

it.skipIf(process.platform === "win32")(
  "requires owner-only key permissions on Unix",
  async () => {
    const publicKey = join(folder, "unsafe-key");
    writeFileSync(publicKey, randomBytes(32), { mode: 0o644 });
    chmodSync(publicKey, 0o644);
    await expect(
      encryptPaperBackup(source, next("unsafe-key-output"), publicKey),
    ).rejects.toThrow("UNSAFE_BACKUP_KEY_PERMISSIONS");
  },
);
