import "./enforce-node-version.mjs";
import { unlinkSync, writeFileSync } from "node:fs";
import {
  acquireInstanceLock,
  instanceRoot,
} from "../apps/worker/src/deployment-safety.ts";
import {
  createPaperBackup,
  restorePaperBackup,
  verifyPaperBackup,
} from "../apps/worker/src/paper-backup.ts";
import {
  encryptPaperBackup,
  decryptPaperBackup,
} from "../apps/worker/src/encrypted-paper-backup.ts";

// No default action and no worker/service control. Paths are positional arguments,
// not shell programs. MODE is checked even for offline maintenance operations.
try {
  if (process.env.MODE && process.env.MODE !== "PAPER")
    throw Error("ONLY_PAPER_SUPPORTED");
  const [command, source, target, keyFile, ...extra] = process.argv.slice(2);
  const encrypted = command === "encrypt" || command === "decrypt";
  if (
    !source ||
    extra.length ||
    ![
      "maintenance-on",
      "maintenance-off",
      "backup",
      "verify",
      "restore-rehearsal",
      "encrypt",
      "decrypt",
    ].includes(command) ||
    (encrypted ? !target || !keyFile : keyFile !== undefined) ||
    (command === "backup" || command === "restore-rehearsal" || encrypted
      ? !target
      : target !== undefined)
  )
    throw Error(
      "USAGE: paper-maintenance.ts maintenance-on|maintenance-off <database>; backup <database> <new-directory>; verify <backup>; restore-rehearsal <backup> <new-directory>; encrypt|decrypt <source-directory> <new-directory> <key-file>",
    );
  if (encrypted) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    try {
      await (command === "encrypt" ? encryptPaperBackup : decryptPaperBackup)(
        source,
        target!,
        keyFile!,
        { signal: controller.signal },
      );
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  } else if (command === "maintenance-on") {
    try {
      writeFileSync(
        instanceRoot(source) + ".maintenance",
        "PAPER deployment maintenance\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } else if (command === "maintenance-off") {
    const lock = acquireInstanceLock(source);
    try {
      unlinkSync(lock.root + ".maintenance");
    } finally {
      lock.close();
    }
  } else if (command === "backup") {
    await createPaperBackup(source, target!);
  } else if (command === "verify") {
    verifyPaperBackup(source);
  } else {
    restorePaperBackup(source, target!);
  }
  console.info(
    JSON.stringify({ event: "PAPER_MAINTENANCE_OK", command, mode: "PAPER" }),
  );
} catch (error) {
  // No raw filesystem errors (paths may contain user data), DB rows or secrets.
  const message = error instanceof Error ? error.message : "";
  console.error(
    /^[A-Z][A-Z_]+$/.test(message) || message.startsWith("USAGE:")
      ? message
      : "PAPER_MAINTENANCE_FAILED",
  );
  process.exitCode = 1;
}
