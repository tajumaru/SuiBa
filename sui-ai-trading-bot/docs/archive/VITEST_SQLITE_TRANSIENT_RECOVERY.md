# Vitest collection and SQLite transient recovery

Base: `93d3414f1b38f34f44481faff1a5c98f0bfb12c1` (`origin/main`, fetched 2026-10-24).

## Changes and rationale

- Vitest now extends `configDefaults.exclude` with only `tools/sui-transport-bench/bench.test.mjs`. The node:test benchmark is unchanged and remains runnable independently.
- `BotDatabase.sql()` previously latched every non-CONSTRAINT error, including immediate writer contention with `busy_timeout=0`.
- Numeric node:sqlite `errcode` values 5 (BUSY), 261 (BUSY_RECOVERY), 517 (BUSY_SNAPSHOT), and 773 (BUSY_TIMEOUT) now propagate unchanged without setting the permanent fault. There is no retry or timeout change. Successful SQL after unlock uses the same instance.
- Only positive signed 32-bit integer errcodes are decoded. Numeric strings, symbolic strings, missing/invalid codes and unknown BUSY extensions remain fail-closed. The Node error's string `code` is `ERR_SQLITE_ERROR`; it is not a SQLite result code. Messages are never used to infer recovery.
- LOCKED (6), SHAREDCACHE (262), and VTAB (518) remain latched: they describe same-connection/shared-cache conflicts rather than separate-writer BUSY. An actual open-cursor/DROP TABLE conflict reproduces numeric errcode 6 and string code ERR_SQLITE_ERROR on the tested runtime.
- CORRUPT/NOTADB, I/O, READONLY and unknown failures retain requiresRestart=true. Existing primary/extended CONSTRAINT handling and rollback behavior are preserved.

Reference: [SQLite result codes](https://www.sqlite.org/rescode.html), including BUSY, LOCKED and the three documented BUSY extensions. BUSY_SNAPSHOT requires abandoning the old transaction, not retrying a statement within the same snapshot; this patch adds no retry mechanism.

## Verification

Interpreter: Node.js **v24.22.1**, Windows x64, executable:
`D:\Source\SuiBa\.worktrees\validation-ux\sui-ai-trading-bot\.runtime\node-v24.22.1-win-x64\node-v24.22.1-win-x64\node.exe`.
Process-local PATH was pinned to that interpreter; project scripts also log and enforce the version and propagate process.execPath to their children. pnpm 9.12.3; existing installed dependencies were used; manifests and lockfile were unchanged.

| Check | Result |
| --- | --- |
| pnpm test | exit 0; 43 files, 596 passed, 0 failed |
| node --test tools/sui-transport-bench/bench.test.mjs | exit 0; 6 passed |
| pnpm run typecheck | exit 0 |
| pnpm run build | exit 0; existing third-party zod annotation warning |
| pnpm run test:offline | exit 0; 41 files, 567 passed, 7 skipped |
| lint | Not defined in package.json; not claimed as run |
| git diff --check | Passed |

All original 579 Vitest cases remain. Added 17: four known BUSY codes, twelve permanent/unknown/malformed cases, and one real LOCKED reproduction. Existing lock/evidence tests were updated from permanent-BUSY expectations to same-instance SQL recovery, while retaining prompt failure, rollback, zero orders/trades, sticky Sui evidence failure and closed order-gate assertions. The offline configuration already excludes two loopback suites and seven named network-dependent cases; it was not changed. The full suite uses mock transports and isolated loopback fixtures. No external Sui/DeepBook communication, Docker operation or existing DB access was performed.

An initial targeted run failed because six tests expected the old permanent BUSY latch. After updating those expectations, an intermediate engine expectation also failed: runtime stop cannot be persisted while SQLite is locked. The final assertions explicitly capture this limitation rather than claiming a persisted stop. Final runs above have no failures.

## Safety and remaining limitations

No trading strategy, order gate, worker, recovery rule, timeout, retry, schema or SQLite pragma was changed. BUSY remains an exception: a rejected operation is never acknowledged as saved. health().healthy means no permanent DB fault; it does not prove the last write succeeded.

If the writer lock prevents the engine from recording its stop, the persisted running intent may remain true. The existing production scheduler handles the rejected tick by exiting with code 1; boot applies the existing stopped state. Tests verify the tick rejects with actual errcode 5, no quote/order/fill occurs, the order gate remains closed, and the Sui evidence client remains faulted after unlock (manual stop both true and false). The isolated engine fixture is not treated as proof that the production process itself was launched and exited under a lock; that subprocess scenario was not added. Its subsequent ticks do not establish successful recovery. Direct SQL recovery must not be interpreted as automatic Bot recovery.

The Sui evidence fault remains sticky and can still require replacing/restarting that client/worker. This patch only removes the unnecessary permanent DB-connection fault for documented contention. LOCKED is intentionally conservative and is not made recoverable. Unknown future BUSY extensions also remain conservative until reviewed. No long-duration or live-network validation was performed.
