// End-of-observation evidence only. Never submits orders or changes the worker.
const endpoint =
  "https://deepbook-indexer.mainnet.mystenlabs.com/orderbook/SUI_USDC?level=2&depth=10";
const endBookTimeoutMs = 8000;

// A book may predate the request, or be updated while the request is in flight.
// It must never postdate completion. Wall-clock and monotonic durations are
// checked independently: a clock adjustment must not turn a late read into proof.
function endBookTiming(book, observationStart, auditAt) {
  if (
    !book ||
    ![
      book.startedAt,
      book.completedAt,
      book.durationMs,
      observationStart,
      auditAt,
    ].every(Number.isFinite)
  )
    return { status: "MISSING", reason: "END_BOOK_TIMING_MISSING" };
  if (book.startedAt > book.completedAt || book.durationMs < 0)
    return { status: "FAIL", reason: "END_BOOK_TIME_REVERSED" };
  if (
    book.durationMs > endBookTimeoutMs ||
    book.completedAt - book.startedAt > endBookTimeoutMs
  )
    return { status: "FAIL", reason: "END_BOOK_TIMEOUT" };
  if (book.startedAt < observationStart || book.completedAt > auditAt)
    return { status: "FAIL", reason: "END_BOOK_OUTSIDE_AUDIT_WINDOW" };
  if (book.source !== "DeepBook:SUI_USDC" || !Number.isFinite(book.timestamp))
    return { status: "MISSING", reason: "END_BOOK_EVIDENCE_MISSING" };
  if (book.timestamp > book.completedAt)
    return { status: "FAIL", reason: "END_BOOK_FUTURE_TIMESTAMP" };
  if (book.error !== null)
    return { status: "MISSING", reason: "END_BOOK_READ_FAILED" };
  return { status: "PASS", reason: null };
}

async function captureEndBook(
  transport = fetch,
  now = Date.now,
  mono = () => performance.now(),
) {
  const startedAt = now();
  const began = mono();
  const signal = AbortSignal.timeout(endBookTimeoutMs);
  const finish = (timestamp, error) => {
    const result = {
      startedAt,
      completedAt: now(),
      durationMs: mono() - began,
      timestamp,
      error,
      source: "DeepBook:SUI_USDC",
    };
    const timing = endBookTiming(result, startedAt, result.completedAt);
    if (timing.status === "FAIL") result.error = timing.reason;
    return result;
  };
  try {
    const response = await transport(endpoint, {
      headers: { accept: "application/json" },
      signal,
    });
    signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel();
      return finish(null, "END_BOOK_HTTP_FAILED");
    }
    const body = await response.json();
    signal.throwIfAborted();
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
    return finish(valid ? timestamp : null, valid ? null : "END_BOOK_INVALID");
  } catch {
    return finish(null, "END_BOOK_READ_FAILED");
  }
}
module.exports = { captureEndBook, endBookTiming, endBookTimeoutMs };
