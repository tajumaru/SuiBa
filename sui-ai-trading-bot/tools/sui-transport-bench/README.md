# Sui transport comparison — isolated preliminary harness

This tool does not import Bot modules, load dotenv, open databases, listen on ports,
or start trading, PAPER mode, or an operational validation session. Existing
3100/3101/3104 databases and validation history must never be mounted or copied here.
Bot dependencies and transport are unchanged.

Approved preflight was performed on 2026-10-23 and stopped at a Native deadline.
See [the result report](REPORT_20261023.md). No further live run is authorized by
the existence of the CLI flag. Dedicated dependencies are now installed and locked
(grpc-js 1.14.6); the preparation notes below describe the original preflight plan.

## Offline validation (no dependencies needed)

From the Bot directory:

```powershell
node --test tools/sui-transport-bench/bench.test.mjs
node tools/sui-transport-bench/bench.mjs
```

The second command only validates and prints the plan. It makes zero network calls.
Tests use injected promises/errors; they are not a real DNS/socket fault simulation.

## Proposed live preflight — requires explicit user approval

Before any live invocation, obtain approval for the exact endpoint, operation,
request limit and interval. The proposed initial plan reads SUI metadata from
`https://fullnode.mainnet.sui.io:443`: 30 pairs, at most 60 logical reads, one at a
time, at least 5 seconds after each completion, each read bounded by 10 seconds.
There is no warm-up traffic or application retry. Stop on a deadline, resource
exhaustion/429, three consecutive failures, or worker watchdog failure. No automatic
recovery probes are sent. The normal duration is at least 5 minutes plus response
time; the conservative duration bound is about 15 minutes plus setup/teardown.

Install dependencies separately in this directory, using an isolated package
manager invocation that does not change the Bot workspace lockfile. Review the
local lockfile before live execution. Record Node, Undici and resolved dependency versions and the source commit
with the approved run. Do not use Docker or the Bot startup scripts.

The live entry point is deliberately explicit:

```powershell
# ONLY after separate approval and dependency preparation
node tools/sui-transport-bench/bench.mjs --approved-live tools/sui-transport-bench/plan.example.json
```

Results are written only below this tool's `results/<timestamp>/`, with the plan,
individual attempts and summary. No response body, owner, digest or raw error text
is logged in attempt records. The plan file does contain the requested public read
parameters, so never put secrets or credential URLs in a plan.

## Scope and interpretation

- Both adapters use Sui SDK 2.37.0 and identical SDK calls, includes and signals.
  Web intentionally uses the existing default text/base64 format. Native uses TLS,
  a persistent transport, a 10-second RPC deadline and disables grpc-js retries.
- Independent child processes keep CPU and memory accounting separate. AB/BA
  alternation balances ordering. Both processes retain their clients; the first
  observation includes lazy connection setup. This is a warm-session preflight,
  not a controlled cold-connection comparison or a reproduction of Bot safety.
- The shared logical deadline includes SDK resolution/decoding. Native also has
  the RPC deadline. The harness does not reproduce Bot queues, cache, 429 retry,
  safety callbacks or the 45-second market-acquisition budget. Those require
  separate offline integration tests before any production change.
- Success means SDK completion plus basic shape validation before deadline, not
  merely HTTP 200. Quantiles for successful reads and all completed attempts are
  separate; unmatched pairs on early stop remain visible. P99 with 30 observations
  is exploratory. No statistical superiority claim should be made from this run.
- CPU is per-call process CPU; memory is sampled after calls, not a sampled peak.
  Idle baselines, peak sampling, confidence intervals, paired analysis, detailed
  DNS/TCP/TLS/header timings, connection IDs/IPs, wire request counting, and recovery
  time measurement are not implemented yet. Recovery time is explicitly null.
- Failure codes retain known DNS/connect evidence, but generic native errors are
  classified as unknown phase. Do not infer connection or DNS failure solely from
  UNAVAILABLE/DEADLINE_EXCEEDED. Phase timing requires an additional instrumented
  fixture and adapter work, independently validated for measurement overhead.
- The current Web adapter is raw SDK Fetch, without the Bot's whole-body buffering
  wrapper. This isolates a transport comparison; it cannot by itself quantify the
  production buffering wrapper's overhead. An additional controlled wrapper arm is
  necessary for that question.

No measured comparison result is included. Keep the existing production transport
until an approved experiment produces sufficient evidence and safety compatibility
has been verified. Live runs, Docker operations and production switching each need
prior approval; no LIVE/PAPER/24-hour operational validation is authorized here.
