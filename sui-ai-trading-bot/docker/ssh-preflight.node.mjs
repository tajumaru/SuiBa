// Mocked SSH/ssh-keygen only. Never contacts a server or handles a real key.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

for (const scenario of [
  "success",
  "bad-host",
  "admin-user",
  "bad-port-zero",
  "bad-port-range",
  "key-failure",
  "pin-missing",
  "connection-failure",
  "unexpected-output",
  "wrong-user",
  "bad-metrics",
  "zero-disk",
]) {
  test(
    `SSH preflight: ${scenario}`,
    { skip: process.platform !== "linux" },
    () => {
      const folder = mkdtempSync(join(tmpdir(), "suiba-ssh-mock-"));
      const bin = join(folder, "bin"),
        temp = join(folder, "runner"),
        log = join(folder, "calls");
      try {
        mkdirSync(bin);
        mkdirSync(temp);
        writeFileSync(
          join(bin, "ssh-keygen"),
          `#!/bin/sh
if [ "$1" = -y ] && [ "$SCENARIO" = key-failure ]; then echo fixture-sensitive-error >&2; exit 1; fi
if [ "$1" = -F ] && [ "$SCENARIO" = pin-missing ]; then exit 1; fi
exit 0
`,
          { mode: 0o755 },
        );
        writeFileSync(
          join(bin, "ssh"),
          `#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(process.env.CALLS,JSON.stringify(process.argv.slice(2)));
if(process.env.SCENARIO==='connection-failure'){console.error('fixture-sensitive-error');process.exit(255)}
const reply=['SSH_PREFLIGHT_OK','suiba-deploy','29.9.2','v2.40.1','5:29.9.2-1~ubuntu.26.04~resolute','2048000','1024000','80000000'];
if(process.env.SCENARIO==='wrong-user')reply[1]='ubuntu';
if(process.env.SCENARIO==='bad-metrics')reply[6]='fixture-sensitive-error';
if(process.env.SCENARIO==='zero-disk')reply[7]='0';
console.log(process.env.SCENARIO==='unexpected-output'?'unexpected-sensitive-output':reply.join('\\n'));
`,
          { mode: 0o755 },
        );
        const script = join(folder, "ssh-preflight.sh");
        writeFileSync(
          script,
          readFileSync("docker/ssh-preflight.sh", "utf8").replaceAll(
            "\r\n",
            "\n",
          ),
        );
        const result = spawnSync("bash", [script], {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            PATH: bin + ":" + process.env.PATH,
            RUNNER_TEMP: temp,
            SCENARIO: scenario,
            CALLS: log,
            VPS_HOST: scenario === "bad-host" ? "host;bad" : "fixture.invalid",
            VPS_USER: scenario === "admin-user" ? "ubuntu" : "suiba-deploy",
            VPS_PORT:
              scenario === "bad-port-zero"
                ? "0"
                : scenario === "bad-port-range"
                  ? "65536"
                  : "2222",
            VPS_SSH_KEY: "fixture-private-key-never-log",
            VPS_KNOWN_HOSTS: "fixture-pinned-host-never-log",
          },
        });
        if (scenario === "success") {
          assert.equal(result.status, 0, result.stderr);
          const args = JSON.parse(readFileSync(log, "utf8"));
          for (const opt of [
            "BatchMode=yes",
            "StrictHostKeyChecking=yes",
            "IdentityAgent=none",
            "HostKeyAlgorithms=ssh-ed25519",
            "PasswordAuthentication=no",
          ])
            assert.ok(args.includes(opt));
          const command = args.at(-1);
          assert.match(command, /docker --version/);
          assert.match(command, /docker compose version/);
          assert.match(command, /id -un/);
          assert.match(command, /MemAvailable/);
          assert.match(command, /df -Pk/);
          assert.match(command, /dpkg-query/);
          const syntax = spawnSync("sh", ["-n"], {
            input: command,
            encoding: "utf8",
          });
          assert.equal(syntax.status, 0, syntax.stderr);
          assert.doesNotMatch(
            command,
            /sudo|docker run|compose up|deploy-vps|mkdir|rm |cat |printenv|\benv\b/,
          );
          assert.ok(args.includes("-T") && args.includes("-n"));
          assert.match(
            result.stdout,
            /MemoryTotalKiB=2048000 MemoryAvailableKiB=1024000 DiskAvailableKiB=80000000/,
          );
          assert.match(result.stdout, /DockerCLI=29.9.2 Compose=v2.40.1/);
        } else {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /SSH_CHECK_FAILED/);
          if (
            ![
              "connection-failure",
              "unexpected-output",
              "wrong-user",
              "bad-metrics",
              "zero-disk",
            ].includes(scenario)
          )
            assert.equal(existsSync(log), false);
        }
        for (const value of [
          "fixture-private-key-never-log",
          "fixture-pinned-host-never-log",
          "fixture-sensitive-error",
          "unexpected-sensitive-output",
          "fixture.invalid",
          "suiba-deploy",
        ])
          assert.ok(!(result.stdout + result.stderr).includes(value));
        assert.deepEqual(
          readdirSync(temp),
          [],
          "temporary credentials must be removed",
        );
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );
}

test("SSH workflow is dispatch-only, gated off by default, and has no deployment steps", () => {
  // Run this source check on host CI, where the repository-root .github exists.
  const workflow = readFileSync(
    "../.github/workflows/suiba-ssh-preflight.yml",
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /vars.SUIBA_SSH_CHECK_ENABLED == 'true'/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /inputs.confirmation == 'CHECK-SSH-ONLY'/);
  assert.match(workflow, /environment: sakura-vps/);
  assert.doesNotMatch(
    workflow,
    /^\s+(push|pull_request|schedule|workflow_call):|DEPLOY-PAPER|deploy-vps|ADMIN_TOKEN|secrets: inherit/m,
  );
});
