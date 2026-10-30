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

// No default action and no worker/service control. Paths are positional arguments,
// not shell programs. MODE is checked even for offline maintenance operations.
try {
  if (process.env.MODE && process.env.MODE !== "PAPER")
    throw Error("ONLY_PAPER_SUPPORTED");
  const [command, source, target, ...extra] = process.argv.slice(2);
  if (
    !source ||
    extra.length ||
    ![
      "maintenance-on",
      "maintenance-off",
      "backup",
      "verify",
      "restore-rehearsal",
    ].includes(command) ||
    (command === "backup" || command === "restore-rehearsal"
      ? !target
      : target !== undefined)
  )
    throw Error(
      "USAGE: paper-maintenance.ts maintenance-on|maintenance-off <database>; backup <database> <new-directory>; verify <backup>; restore-rehearsal <backup> <new-directory>",
    );
  if (command === "maintenance-on") {
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
