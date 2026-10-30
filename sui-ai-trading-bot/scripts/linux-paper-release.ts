import "./enforce-node-version.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  LinuxPaperRelease,
  type ServiceControl,
} from "../apps/worker/src/linux-paper-release.ts";
import { packageLinuxRelease } from "../apps/worker/src/linux-release-artifact.ts";

try {
  if (process.platform !== "linux") throw Error("LINUX_RELEASE_REQUIRED");
  if (process.env.MODE && process.env.MODE !== "PAPER")
    throw Error("ONLY_PAPER_SUPPORTED");
  const [command, argument, destination, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !argument ||
    ![
      "package",
      "prepare",
      "activate",
      "unlock",
      "rollback",
      "status",
      "cancel",
    ].includes(command) ||
    (command === "package"
      ? !destination
      : command === "activate"
        ? destination !== "--offhost-backup-confirmed"
        : destination !== undefined)
  )
    throw Error(
      "USAGE: linux-paper-release.ts package <sha> <new-directory>; prepare <sha>; activate <id> --offhost-backup-confirmed; unlock|rollback|cancel|status <id>",
    );
  if (command === "package") {
    packageLinuxRelease(process.cwd(), destination!, argument);
  } else {
    if (process.getuid?.() === 0)
      throw Error("DO_NOT_RUN_RELEASE_CODE_AS_ROOT");
    const unit = "suiba-paper.service";
    const control = (action: "stop" | "start" | "show") =>
      execFileSync(
        "/usr/bin/sudo",
        [
          "--non-interactive",
          "/usr/bin/systemctl",
          action,
          unit,
          ...(action === "show" ? ["--property=ActiveState", "--value"] : []),
        ],
        { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    const service: ServiceControl = {
      async stop() {
        control("stop");
      },
      async stopped() {
        return ["inactive", "failed"].includes(control("show"));
      },
      async start() {
        control("start");
      },
      async probe() {
        const token = readFileSync("/etc/suiba/admin-token", "utf8").trim();
        if (token.length < 32) throw Error("INVALID_PROBE_CREDENTIAL");
        const origin = "http://127.0.0.1:3100";
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          try {
            const denied = await fetch(origin + "/api/deployment", {
              redirect: "error",
              signal: AbortSignal.timeout(2000),
            });
            await denied.body?.cancel();
            if (denied.status !== 401)
              throw Error("UNAUTHENTICATED_API_EXPOSED");
            const response = await fetch(origin + "/api/deployment", {
              headers: { Authorization: `Bearer ${token}` },
              redirect: "error",
              signal: AbortSignal.timeout(2000),
            });
            if (!response.ok) {
              await response.body?.cancel();
              throw Error("PROBE_UNAVAILABLE");
            }
            return (await response.json()) as Awaited<
              ReturnType<ServiceControl["probe"]>
            >;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "UNAUTHENTICATED_API_EXPOSED"
            )
              throw error;
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        throw Error("PROBE_UNAVAILABLE");
      },
    };
    const manager = new LinuxPaperRelease(
      {
        releases: "/opt/suiba/releases",
        state: "/var/lib/suiba-release",
        database: "/var/lib/suiba/bot.sqlite",
        backups: "/var/backups/suiba",
        key: "/etc/suiba/backup.key",
      },
      service,
    );
    if (command === "prepare") {
      const transaction = await manager.prepare(argument);
      console.info(
        JSON.stringify({
          event: "PAPER_RELEASE_PREPARED",
          transaction,
          mode: "PAPER",
        }),
      );
    } else if (command === "activate") await manager.activate(argument, true);
    else if (command === "unlock") await manager.unlock(argument);
    else if (command === "rollback") await manager.rollback(argument);
    else if (command === "cancel") await manager.cancel(argument);
    else {
      const state = manager.status(argument);
      console.info(
        JSON.stringify({
          transaction: state.id,
          phase: state.phase,
          from: state.from,
          to: state.to,
        }),
      );
    }
  }
  console.info(
    JSON.stringify({
      event: "PAPER_RELEASE_COMMAND_OK",
      command,
      mode: "PAPER",
    }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  console.error(
    /^[A-Z][A-Z_]+$/.test(message) || message.startsWith("USAGE:")
      ? message
      : "PAPER_RELEASE_FAILED",
  );
  process.exitCode = 1;
}
