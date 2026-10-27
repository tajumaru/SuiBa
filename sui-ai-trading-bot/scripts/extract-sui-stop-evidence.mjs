// Offline file analysis only. Never opens a DB, socket, service or container.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { assertNodeVersion } from "./verify-node-version.mjs";
assertNodeVersion({ report: false });
const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw Error(
    "USAGE: node scripts/extract-sui-stop-evidence.mjs INPUT.jsonl OUTPUT.json",
  );
const bytes = readFileSync(input);
const sha256 = createHash("sha256").update(bytes).digest("hex");
// This extractor describes one historical run; reject another/truncated source
// rather than attaching that run's identity or limitations to unrelated data.
if (
  sha256 !== "fd22a73695a3a4e9a707c87cc84049290513db28d6c574b9b0fb69bc156769a4"
)
  throw Error("HISTORICAL_SOURCE_HASH_MISMATCH");
const rows = bytes
  .toString("utf8")
  .trim()
  .split(/\r?\n/)
  .map((line, i) => ({ ...JSON.parse(line), sourceLine: i + 1 }));
const ref = (r) => ({
  sourceLine: r.sourceLine,
  at: r.at,
  utc: new Date(r.at).toISOString(),
});
const failures = rows.filter(
  (r) => r.kind === "api" && r.data.api === "Sui gRPC" && !r.data.success,
);
const cycles = rows.filter(
  (r) => r.kind === "cycle" && r.error === "SUI_READ_FAILED",
);
const summary = {
  schema: 1,
  source: "preflight-8b05f2a/evidence-final.jsonl",
  sha256,
  sourceRows: rows.length,
  build: rows.find((r) => r.kind === "observer")?.sha ?? null,
  limitations: [
    "Historical preflight; not latest-main runtime evidence",
    "Coin/request/health IDs absent; individual failed coin cannot be determined",
    "Bot was already stopped; these records do not demonstrate a running-to-stopped transition",
    "Cycle correlation uses timestamps, not a shared request ID",
  ],
  failures: failures.map((r) => ({
    ...ref(r),
    api: r.data.api,
    code: r.data.code,
    attempt: r.data.attempt,
    occurredAt: r.data.occurredAt,
    latencyMs: r.data.latencyMs,
    operation: r.data.failure?.operation ?? null,
    phase: r.data.failure?.phase ?? null,
    causeCode: r.data.failure?.causeCode ?? null,
    status: r.data.failure?.status ?? null,
    elapsedMs: r.data.failure?.elapsedMs ?? null,
    startedAt: r.data.failure?.startedAt ?? null,
    endedAt: r.data.failure?.endedAt ?? null,
    cycleLine:
      cycles.find(
        (c) => c.began <= r.data.occurredAt && c.at >= r.data.occurredAt,
      )?.sourceLine ?? null,
  })),
  cycles: cycles.map((c) => {
    const next = rows.find((r) => r.kind === "sample" && r.at >= c.at);
    return {
      ...ref(c),
      began: c.began,
      durationMs: c.durationMs,
      error: c.error,
      cycleId: c.execution?.cycleId,
      runningAtStart: c.execution?.runningAtStart,
      analysis: c.execution?.analysis,
      frameKeys: Object.keys(c.frames ?? {}),
      priorMarketSuccessAt: c.market?.lastSuccessAt,
      nextSample: next
        ? {
            ...ref(next),
            running: next.runtime?.running,
            error: next.runtime?.error,
            connectivity: next.safety?.connectivity,
            resumePending: next.safety?.resumePending,
            generation: next.safety?.generation,
          }
        : null,
    };
  }),
};
writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
console.log(
  JSON.stringify({
    sha256: summary.sha256,
    failures: summary.failures.length,
    cycles: summary.cycles.length,
  }),
);
