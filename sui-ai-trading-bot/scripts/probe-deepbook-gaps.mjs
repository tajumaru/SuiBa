import fs from "node:fs";
const historical = JSON.parse(
  fs.readFileSync("docs/evidence/gaps/historical-5m.json"),
);
if (!process.argv.includes("--fetch")) {
  const saved = JSON.parse(
    fs.readFileSync("docs/evidence/gaps/cross-check.json"),
  );
  console.log(
    JSON.stringify({
      mode: "saved evidence only; no API calls",
      missing: historical.missing.length,
      zeroIndexedTrades: saved.gaps.filter(
        (x) => x.queryComplete && !x.trades.length,
      ).length,
      recheck:
        "Add --fetch to make paced read-only requests; writes to a new data/gap-probe directory.",
    }),
  );
  process.exit(0);
}
const dir = "data/gap-probe-" + Date.now();
fs.mkdirSync(dir, { recursive: true });
console.log("Writing public evidence to " + dir);
const output = {
  observedAt: Date.now(),
  from: historical.from,
  to: historical.to,
  queries: [],
  minutes: [],
  fifteen: [],
  gaps: [],
};
let previous = 0;
async function read(path) {
  const wait = Math.max(0, 2500 - (Date.now() - previous));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  previous = Date.now();
  const start = Date.now();
  const r = await fetch(
    "https://deepbook-indexer.mainnet.mystenlabs.com" + path,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!r.ok) throw Error("HTTP_" + r.status);
  const data = await r.json();
  output.queries.push({
    path,
    status: r.status,
    elapsedMs: Date.now() - start,
    observedAt: Date.now(),
  });
  return data;
}
function save() {
  fs.writeFileSync(dir + "/cross-check.json", JSON.stringify(output) + "\n");
}
const fivePath =
  "/ohclv/SUI_USDC?interval=5m&start_time=" +
  historical.from * 1000 +
  "&end_time=" +
  historical.to * 1000 +
  "&limit=2000";
const five = await read(fivePath),
  times = new Set(five.candles.map((x) => x[0] / 1000));
historical.missing = [];
for (let t = historical.from; t < historical.to; t += 300)
  if (!times.has(t))
    historical.missing.push({
      timestamp: t,
      utc: new Date(t * 1000).toISOString(),
    });
if (historical.missing.length > 64)
  throw Error("MORE_THAN_64_GAPS; refusing unbounded queries");
fs.writeFileSync(
  dir + "/historical-5m.json",
  JSON.stringify(
    {
      from: historical.from,
      to: historical.to,
      missing: historical.missing,
      raw: five,
    },
    null,
    2,
  ) + "\n",
);
let cursor = historical.to * 1000;
for (let page = 0; page < 8; page++) {
  const raw = await read(
    "/ohclv/SUI_USDC?interval=1m&start_time=" +
      historical.from * 1000 +
      "&end_time=" +
      cursor +
      "&limit=1000",
  );
  output.minutes.push(...raw.candles);
  save();
  console.log(
    JSON.stringify({ minutePage: page + 1, count: raw.candles.length }),
  );
  if (raw.candles.length < 1000) break;
  const earliest = Math.min(...raw.candles.map((x) => x[0]));
  if (earliest >= cursor) throw Error("PAGINATION_STALLED");
  cursor = earliest - 1000;
  if (cursor < historical.from * 1000) break;
  if (page === 7) throw Error("MINUTE_PAGE_LIMIT_REACHED; evidence incomplete");
}
output.fifteen = (
  await read(
    "/ohclv/SUI_USDC?interval=15m&start_time=" +
      historical.from * 1000 +
      "&end_time=" +
      historical.to * 1000 +
      "&limit=1000",
  )
).candles;
for (const gap of historical.missing) {
  const raw = await read(
    "/trades/SUI_USDC?start_time=" +
      gap.timestamp +
      "&end_time=" +
      (gap.timestamp + 300) +
      "&limit=1000",
  );
  if (!Array.isArray(raw)) throw Error("INVALID_TRADES");
  const selected = raw.filter(
    (x) =>
      x.timestamp >= gap.timestamp * 1000 &&
      x.timestamp < (gap.timestamp + 300) * 1000,
  );
  output.gaps.push({
    ...gap,
    returned: raw.length,
    queryComplete: raw.length < 1000,
    trades: selected.map((x) => ({
      timestamp: x.timestamp,
      digest: x.digest,
      event_digest: x.event_digest,
      price: x.price,
      base_volume: x.base_volume,
    })),
    minuteCount: output.minutes.filter(
      (x) =>
        x[0] >= gap.timestamp * 1000 && x[0] < (gap.timestamp + 300) * 1000,
    ).length,
  });
  save();
  if (
    output.gaps.length % 10 === 0 ||
    output.gaps.length === historical.missing.length
  )
    console.log(
      JSON.stringify({
        checked: output.gaps.length,
        tradesPresent: output.gaps.filter((x) => x.trades.length).length,
        minuteRows: output.minutes.length,
      }),
    );
}
output.finalStatus = await read(
  "/status?max_checkpoint_lag=100&max_time_lag_seconds=60",
);
output.completedAt = Date.now();
save();
console.log(
  JSON.stringify({
    complete: true,
    gaps: output.gaps.length,
    zeroTrades: output.gaps.filter((x) => x.queryComplete && !x.trades.length)
      .length,
    minutes: output.minutes.length,
  }),
);
