import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import { backtest } from "../../../packages/paper-trading/src/backtest.ts";
const db = new BotDatabase(process.env.DATABASE_PATH ?? "data/bot.sqlite");
try {
  const c = db.candles();
  if (c.length < 200) throw new Error("Need at least 200 saved candles");
  const split = Math.floor(c.length * 0.6);
  const result = await backtest(
    c,
    {
      trainEnd: c[split - 1].timestamp,
      testStart: c[split].timestamp,
      testEnd: c.at(-1)!.timestamp,
      participation: 0.001,
      impact: 0.001,
    },
    db.settings(),
  );
  mkdirSync("data/backtests", { recursive: true });
  const path = `data/backtests/${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.info(
    JSON.stringify(
      { ...result, trades: result.trades.length, report: path },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
