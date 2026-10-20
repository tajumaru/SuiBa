import "dotenv/config";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import { GeckoMarketData } from "../../../packages/market-data/src/index.ts";
import { CetusRouter } from "../../../packages/dex-router/src/index.ts";
import { ReadOnlySuiClient } from "../../../packages/sui-client/src/index.ts";
import { settingsSchema } from "../../../packages/shared/src/index.ts";
import { BotEngine } from "./engine.ts";
if (process.env.MODE && process.env.MODE !== "PAPER")
  throw new Error("ONLY_PAPER_SUPPORTED");
const token = process.env.ADMIN_TOKEN;
if (!token || token.length < 32)
  throw new Error("ADMIN_TOKEN must contain at least 32 characters");
const db = new BotDatabase(process.env.DATABASE_PATH ?? "data/bot.sqlite");
// Persist emergency state; an unclean restart never silently resumes trading.
db.set("runtime", { ...db.runtime(), running: false });
const sui = new ReadOnlySuiClient(process.env.SUI_GRPC_URL),
  engine = new BotEngine(
    db,
    new GeckoMarketData(process.env.MARKET_POOL || undefined),
    new CetusRouter(),
    sui,
  );
let stopping = false;
async function loop() {
  if (stopping) return;
  await engine.tick();
  if (!stopping) setTimeout(loop, db.settings().intervalMs).unref();
}
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  );
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  try {
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") {
        send(405, { error: "METHOD" });
        return;
      }
      const root = resolve("apps/dashboard/dist"),
        file = resolve(
          root,
          "." + (url.pathname === "/" ? "/index.html" : url.pathname),
        );
      if (!file.startsWith(root + "\\") && !file.startsWith(root + "/")) {
        send(404, {});
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type":
          (
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
            } as Record<string, string>
          )[extname(file)] ?? "application/octet-stream",
      });
      res.end(data);
      return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from("Bearer " + token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      send(401, { error: "UNAUTHORIZED" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      send(200, engine.snapshot());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/balances") {
      if (!process.env.READ_ONLY_ADDRESS) {
        send(400, { error: "READ_ONLY_ADDRESS_UNSET" });
        return;
      }
      const { SUI, USDC } =
        await import("../../../packages/shared/src/index.ts");
      send(
        200,
        await Promise.all([
          sui.balance(process.env.READ_ONLY_ADDRESS, SUI),
          sui.balance(process.env.READ_ONLY_ADDRESS, USDC),
        ]),
      );
      return;
    }
    if (req.method !== "POST") {
      send(404, {});
      return;
    }
    // No cookies: browser cannot attach a bearer credential to cross-origin form requests.
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 16384) {
        send(413, {});
        return;
      }
    }
    const body = text ? JSON.parse(text) : {};
    if (url.pathname === "/api/settings") {
      const settings = settingsSchema.parse(body);
      db.updateSettings(settings);
      send(200, settings);
      return;
    }
    if (url.pathname === "/api/control") {
      const command = body.command;
      const r = db.runtime();
      if (command === "emergency")
        db.set("runtime", { ...r, running: false, emergency: true });
      else if (command === "stop") db.set("runtime", { ...r, running: false });
      else if (command === "reset")
        db.set("runtime", {
          ...r,
          running: false,
          emergency: false,
          error: null,
        });
      else if (command === "start") {
        if (r.emergency || r.error) {
          send(409, { error: "RESET_REQUIRED" });
          return;
        }
        if (!sui.status.healthy || Date.now() - sui.status.checkedAt > 180000) {
          send(409, { error: "HEALTH_CHECK_REQUIRED" });
          return;
        }
        db.set("runtime", { ...r, running: true });
      } else {
        send(400, { error: "UNKNOWN_COMMAND" });
        return;
      }
      send(200, db.runtime());
      return;
    }
    send(404, { error: "NOT_FOUND" });
  } catch {
    send(400, { error: "REQUEST_FAILED" });
  }
});
server.listen(
  Number(process.env.PORT ?? 3100),
  process.env.HOST ?? "127.0.0.1",
  () => {
    console.info("PAPER dashboard/API ready");
    void loop();
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
    db.set("runtime", { ...db.runtime(), running: false });
    server.close(() => process.exit(0));
  });
