import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";

import { randomBytes } from "node:crypto";

import { fileURLToPath } from "node:url";

import { dirname, join, resolve } from "node:path";

import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const dir = join(root, "docker");

const command = process.argv[2] ?? "status";

const args = [
  "compose",
  "-p",
  "suiba-deepbook-24h",
  "--env-file",
  join(dir, ".env.deepbook-24h"),
  "-f",
  join(dir, "compose.deepbook-24h.yaml"),
];

function docker(tail, capture = false) {
  return execFileSync("docker", [...args, ...tail], {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

if (command === "init") {
  mkdirSync(join(dir, "secrets"), { recursive: true });

  const secret = join(dir, "secrets/deepbook-24h-admin.txt");

  if (!existsSync(secret))
    writeFileSync(secret, randomBytes(32).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });

  const env = join(dir, ".env.deepbook-24h");

  if (!existsSync(env))
    copyFileSync(join(dir, "deepbook-24h.env.example"), env);

  console.log(
    "専用設定と管理トークンを準備しました。既存ファイルは変更していません。",
  );
} else if (["up", "stop", "restart", "logs", "backup"].includes(command)) {
  if (command === "up") docker(["up", "-d", "--build"]);

  if (command === "stop") docker(["stop", "bot"]);

  if (command === "restart") docker(["restart", "bot"]);

  if (command === "backup") {
    docker(["stop", "bot"]);
    const target = join(
      dir,
      "artifacts",
      "backup-" +
        new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
    );
    mkdirSync(target, { recursive: true });
    mkdirSync(join(target, "reports"));
    docker(["cp", "bot:/app/validation/.", target]);
    docker(["cp", "bot:/app/reports/.", join(target, "reports")]);
    console.log(
      "専用Botを停止し、DBディレクトリ全体とレポートを保存しました: " +
        target +
        "。自動再開しません。",
    );
  }
  if (command === "logs") {
    mkdirSync(join(dir, "artifacts"), { recursive: true });

    writeFileSync(
      join(
        dir,
        "artifacts",
        "deepbook-24h-" +
          new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-") +
          ".log",
      ),
      docker(["logs", "--no-color", "bot"], true),
    );

    console.log("docker/artifacts に時刻付きログを保存しました。");
  }
} else if (["begin", "status", "report"].includes(command)) {
  // Read the credential inside the container; it never appears in CLI arguments/output.

  const script = `import {readFileSync} from 'node:fs';const token=readFileSync(process.env.ADMIN_TOKEN_FILE,'utf8').trim();const r=await fetch('http://127.0.0.1:3100/api/validation${command === "begin" ? "/start" : ""}',{method:'${command === "begin" ? "POST" : "GET"}',headers:{authorization:'Bearer '+token}});if(!r.ok)throw Error('HTTP_'+r.status);process.stdout.write(await r.text());`;

  const data = JSON.parse(
    docker(
      ["exec", "-T", "bot", "node", "--input-type=module", "-e", script],
      true,
    ),
  );

  if (command === "report") {
    mkdirSync(join(dir, "artifacts"), { recursive: true });

    writeFileSync(
      join(dir, "artifacts/deepbook-24h.json"),
      JSON.stringify(data, null, 2),
    );

    const md = script.replace("/api/validation'", "/api/validation/report.md'");

    writeFileSync(
      join(dir, "artifacts/deepbook-24h.md"),
      docker(
        ["exec", "-T", "bot", "node", "--input-type=module", "-e", md],
        true,
      ),
    );

    console.log("JSON / Markdown を docker/artifacts に保存しました。");
  } else console.log(JSON.stringify(data, null, 2));
} else
  throw Error(
    "使用方法: node docker/deepbook-24h.mjs init|up|begin|status|report|logs|backup|stop|restart",
  );
