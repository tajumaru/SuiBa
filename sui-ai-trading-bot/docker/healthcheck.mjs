// Process health only: a safely stopped PAPER bot is a healthy container.
try {
  const response = await fetch(
    `http://127.0.0.1:${process.env.PORT ?? 3100}/healthz`,
    { signal: AbortSignal.timeout(4000) },
  );
  const body = await response.json();
  if (!response.ok || body.mode !== "PAPER" || body.status !== "ok")
    process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
