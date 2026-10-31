// Execute the real deployment shell against a fake Docker CLI. No Worker starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

for (const scenario of [
  "success",
  "maintenance-failure",
  "timeout",
  "shutdown-error",
  "fallback-kill",
  "oom",
  "stop-failure",
  "backup-failure",
  "health-failure",
]) {
  test(
    `deployment shell: ${scenario}`,
    { skip: process.platform !== "linux" },
    () => {
      const folder = mkdtempSync(join(tmpdir(), "suiba-vps-shell-"));
      const sha = "a".repeat(40),
        release = join(folder, "releases", sha),
        bin = join(folder, "bin"),
        log = join(folder, "docker.jsonl");
      try {
        for (const name of [release, bin, join(folder, "shared")])
          mkdirSync(name, { recursive: true });
        for (const name of ["runtime.env", "admin-token"])
          writeFileSync(join(folder, "shared", name), "fixture");
        writeFileSync(join(release, "image.tar.gz"), "image");
        writeFileSync(
          join(release, "image.tar.gz.sha256"),
          createHash("sha256").update("image").digest("hex") +
            "  image.tar.gz\n",
        );
        writeFileSync(
          join(release, "deploy.sh"),
          readFileSync("docker/deploy-vps.sh", "utf8")
            .replaceAll("\r\n", "\n")
            .replaceAll("/opt/suiba", folder),
        );
        writeFileSync(
          join(bin, "docker"),
          `#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2),s=process.env.SCENARIO;
fs.appendFileSync(process.env.DOCKER_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='image') console.log('a'.repeat(40));
if(a[0]==='ps') console.log('old-container');
if(a[0]==='inspect') { const f=a[a.indexOf('--format')+1]; console.log(f.includes('ExitCode')?(s==='timeout'?137:s==='shutdown-error'?1:0):f.includes('OOMKilled')?(s==='oom'?'true':'false'):'false'); }
if(a[0]==='compose') { if(a.includes('ps')) console.log('old-container'); if(a.includes('stop')&&s==='stop-failure')process.exit(1);if(a.includes('up')&&s==='health-failure')process.exit(1); }
if(a[0]==='stop'&&s==='fallback-kill')process.exit(1);
if(a[0]==='run') {if(a.at(-1)==='maintenance'&&['maintenance-failure','fallback-kill'].includes(s))process.exit(1);if(a.at(-1)==='backup'){if(s==='backup-failure')process.exit(1);process.stdout.write('fixture-archive');}}
`,
          { mode: 0o755 },
        );
        const result = spawnSync("bash", [join(release, "deploy.sh"), sha], {
          env: {
            ...process.env,
            PATH: bin + ":" + process.env.PATH,
            SCENARIO: scenario,
            DOCKER_LOG: log,
          },
          encoding: "utf8",
          timeout: 10000,
        });
        assert.ok(existsSync(log), result.stderr || String(result.error));
        const calls = readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const up = calls.findIndex(
          (a) => a[0] === "compose" && a.includes("up"),
        );
        if (scenario === "success") {
          assert.equal(result.status, 0, result.stderr);
          assert.ok(up > 0);
          assert.ok(
            calls.findIndex((a) => a.at(-1) === "maintenance") <
              calls.findIndex((a) => a.includes("stop")),
          );
          assert.ok(calls.findIndex((a) => a.at(-1) === "backup") < up);
        } else {
          assert.notEqual(result.status, 0);
          assert.ok(
            calls.some((a) => a[0] === "update" && a.includes("--restart=no")),
          );
          assert.ok(calls.some((a) => a[0] === "stop" && a.includes("40")));
          if (scenario === "fallback-kill")
            assert.ok(calls.some((a) => a[0] === "kill"));
          if (scenario !== "health-failure") assert.equal(up, -1);
          if (
            [
              "maintenance-failure",
              "fallback-kill",
              "timeout",
              "shutdown-error",
              "oom",
              "stop-failure",
            ].includes(scenario)
          )
            assert.equal(
              calls.some((a) => a.at(-1) === "backup"),
              false,
            );
        }
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );
}
