// Fixed public read-only endpoints. No DB, wallet, retry or Worker startup.
const range = process.argv.includes("--history-ms");
const now = Date.now(),
  start = now - 180 * 86400000;
const paths = [
  "/get_pools",
  "/status?max_checkpoint_lag=100&max_time_lag_seconds=60",
  "/orderbook/SUI_USDC?level=2&depth=10",
  ...["1m", "5m", "15m", "1h", "4h", "1d"].map(
    (interval) =>
      "/ohclv/SUI_USDC?interval=" +
      interval +
      "&limit=1000" +
      (range ? "&start_time=" + start + "&end_time=" + now : ""),
  ),
];
for (const path of paths) {
  const began = Date.now();
  try {
    const response = await fetch(
      "https://deepbook-indexer.mainnet.mystenlabs.com" + path,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) {
      console.log(
        JSON.stringify({
          path,
          status: response.status,
          elapsedMs: Date.now() - began,
        }),
      );
      process.exitCode = 1;
      break;
    }
    const raw = await response.json();
    let data = raw;
    if (path === "/get_pools")
      data = raw.filter((x) => x.pool_name === "SUI_USDC");
    else if (path.startsWith("/status"))
      data = {
        status: raw.status,
        max_checkpoint_lag: raw.max_checkpoint_lag,
        max_time_lag_seconds: raw.max_time_lag_seconds,
        current_time_ms: raw.current_time_ms,
      };
    else if (path.startsWith("/ohclv")) {
      const interval = new URL(
          "https://example.invalid" + path,
        ).searchParams.get("interval"),
        tf = {
          "1m": 60,
          "5m": 300,
          "15m": 900,
          "1h": 3600,
          "4h": 14400,
          "1d": 86400,
        }[interval];
      const rows = raw.candles
        .map((x) => [x[0] >= 1e12 ? x[0] / 1000 : x[0], ...x.slice(1)])
        .filter((x) => (x[0] + tf) * 1000 <= Date.now())
        .sort((a, b) => a[0] - b[0]);
      const expected = rows.length ? (rows.at(-1)[0] - rows[0][0]) / tf + 1 : 0;
      data = {
        received: raw.candles.length,
        closed: rows.length,
        first: rows[0]?.[0],
        last: rows.at(-1)?.[0],
        missing: expected - rows.length,
        missingRate: expected ? (expected - rows.length) / expected : null,
        firstRow: rows[0],
        lastRow: rows.at(-1),
      };
    }
    console.log(
      JSON.stringify({
        path,
        status: response.status,
        elapsedMs: Date.now() - began,
        observedAt: Date.now(),
        data,
      }),
    );
  } catch {
    console.log(
      JSON.stringify({
        path,
        error: "PROBE_FAILED",
        elapsedMs: Date.now() - began,
      }),
    );
    process.exitCode = 1;
    break;
  }
}
// HTTP 200 reports connectivity only; missing/short candles are not approved for trading.
