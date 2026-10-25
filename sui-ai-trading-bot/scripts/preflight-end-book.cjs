// End-of-observation evidence only. Never submits orders or changes the worker.
const endpoint =
  "https://deepbook-indexer.mainnet.mystenlabs.com/orderbook/SUI_USDC?level=2&depth=10";
async function captureEndBook(transport = fetch, now = Date.now) {
  const startedAt = now();
  try {
    const response = await transport(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        startedAt,
        completedAt: now(),
        timestamp: null,
        error: "END_BOOK_HTTP_FAILED",
      };
    }
    const body = await response.json();
    const timestamp = body.timestamp == null ? NaN : Number(body.timestamp);
    const valid =
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      [body.bids, body.asks].every(
        (levels) =>
          Array.isArray(levels) &&
          levels.length &&
          levels.every(
            (level) =>
              Array.isArray(level) &&
              level.length === 2 &&
              level.every(
                (value) => Number.isFinite(Number(value)) && Number(value) > 0,
              ),
          ),
      );
    return {
      startedAt,
      completedAt: now(),
      timestamp: valid ? timestamp : null,
      error: valid ? null : "END_BOOK_INVALID",
      source: "DeepBook:SUI_USDC",
    };
  } catch {
    return {
      startedAt,
      completedAt: now(),
      timestamp: null,
      error: "END_BOOK_READ_FAILED",
    };
  }
}
module.exports = { captureEndBook };
