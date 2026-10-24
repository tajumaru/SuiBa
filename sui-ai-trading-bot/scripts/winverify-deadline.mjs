// Windows unattended verification failsafe (tools/windows-verification).
//
// Loaded ONLY by the verification tool, via NODE_OPTIONS=--import, inside
// the dedicated preflight container. It is inert unless
// SUIBA_WINVERIFY_MAX_RUNTIME_MS holds a plausible duration: every other
// flow (normal PAPER runs, tests, other preflights) never sets that
// variable, so importing this module changes nothing for them.
//
// Purpose: if the Windows host monitor (PowerShell) dies unexpectedly,
// the worker process must not run forever. When the deadline passes this
// preload asks the process to shut down gracefully (SIGTERM, the same
// signal `docker compose stop` sends) and force-exits shortly after if
// the process is still alive. The host monitor stops the container at
// the planned duration first; this is only the last-resort backstop.
const raw = process.env.SUIBA_WINVERIFY_MAX_RUNTIME_MS;
const maxRuntimeMs = Number(raw);
const MIN_MS = 60_000; // 1 minute: anything shorter is a configuration error
const MAX_MS = 26 * 60 * 60_000; // 26 hours: planned max 24h + grace

if (
  typeof raw === "string" &&
  raw.trim() !== "" &&
  Number.isFinite(maxRuntimeMs) &&
  maxRuntimeMs >= MIN_MS &&
  maxRuntimeMs <= MAX_MS
) {
  const deadline = setTimeout(() => {
    try {
      process.stdout.write(
        JSON.stringify({
          event: "WINVERIFY_DEADLINE_REACHED",
          at: Date.now(),
          maxRuntimeMs,
        }) + "\n",
      );
    } catch {
      // Stdout is gone; the shutdown below still applies.
    }
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      // Fall through to the forced exit timer.
    }
    const forced = setTimeout(() => process.exit(1), 25_000);
    forced.unref?.();
  }, maxRuntimeMs);
  deadline.unref?.();
}
