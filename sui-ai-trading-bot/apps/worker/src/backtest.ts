import "dotenv/config";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import { compareBacktests } from "../../../packages/backtest-engine/src/index.ts";
import type { Candle } from "../../../packages/shared/src/index.ts";
// Optional JSON candle array (or a saved report's history) and JSON options file.
const db = new BotDatabase(process.env.DATABASE_PATH ?? "data/bot.sqlite");
try {
  const raw = process.argv[2]
    ? JSON.parse(readFileSync(process.argv[2], "utf8"))
    : null;
  const c: Candle[] = raw
    ? Array.isArray(raw)
      ? raw
      : raw.history
    : db.candles();
  if (!Array.isArray(c) || c.length < 63)
    throw new Error(
      "Need at least 63 candles; use a JSON history file or save more PAPER data",
    );
  const split = Math.max(61, Math.floor(c.length * 0.6));
  const settings = db.settings();
  const options = process.argv[3]
    ? JSON.parse(readFileSync(process.argv[3], "utf8"))
    : (raw?.options ?? {
        start: c[split].timestamp,
        trainEnd: c[split - 1].timestamp,
        end: c.at(-1)!.timestamp,
        maxOrder: settings.maxOrder,
        slippage: settings.maxSlippage,
        additionalFeeRate: 0,
        gasUsdc: settings.gasUsdc,
        minNetProfitUsdc: settings.minNetProfitUsdc,
        minNetProfitPct: settings.minNetProfitPct,
      });
  const result = await compareBacktests(c, options, raw?.settings ?? settings);
  mkdirSync("data/backtests", { recursive: true });
  const path = `data/backtests/${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.info(
    JSON.stringify(
      {
        model: result.model,
        off: result.off.summary,
        on: result.on.summary,
        report: path,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
