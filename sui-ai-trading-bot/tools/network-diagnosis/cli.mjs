import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import dns from "node:dns";
import net from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LIMITS,
  PROFILES,
  plan,
  argsOf,
  authorize,
  writer,
  stopFile,
  pause,
  cycleStop,
  safeCode,
  SUI,
  DEEP,
} from "./core.mjs";

import { measurementWindow, waitUntil } from "./clock.mjs";

export async function run(args) {
  if (!authorize(args)) return plan();
  const startAt = Number(args.startAt),
    out = resolve(args.out ?? "");
  if (
    !args.out ||
    !Number.isFinite(startAt) ||
    startAt < Date.now() - 1000 ||
    startAt > Date.now() + 120000
  )
    throw Error("INVALID_START_OR_OUTPUT");
  const emit = writer(out, args.runId, args.side),
    control = new AbortController();
  let reason = "RUN_DEADLINE",
    resources,
    stopWatch,
    deadline;
  const window = measurementWindow(startAt);
  const stop = (why) => {
    reason = why;
    control.abort(Error(why));
    try {
      if (why !== "RUN_DEADLINE" && !existsSync(stopFile(out)))
        writeFileSync(stopFile(out), why);
    } catch {
      reason = "EVIDENCE_WRITE_FAILED";
    }
  };
  process.once("SIGTERM", () => stop("USER_STOP"));
  process.once("SIGINT", () => stop("USER_STOP"));
  // No imports of Bot / DB / dotenv. SDK and Agent loading happens only after authorization.
  const { createHarness } = await import("./transports.mjs");
  const harness = await createHarness();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const cpuStart = process.cpuUsage();
  let previousCpu = cpuStart,
    previousAt = performance.now(),
    windowStart = Date.now();
  const sample = () => {
    const now = performance.now(),
      cpu = process.cpuUsage(),
      memory = process.memoryUsage();
    emit({
      kind: "resource",
      at: Date.now(),
      windowStart,
      windowEnd: Date.now(),
      cpuPercent:
        (cpu.user + cpu.system - previousCpu.user - previousCpu.system) /
        ((now - previousAt) * 10),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      eventLoopCount: loop.count,
      eventLoopMaxMs: loop.count ? loop.max / 1e6 : null,
      eventLoopP95Ms: loop.count ? loop.percentile(95) / 1e6 : null,
    });
    previousCpu = cpu;
    previousAt = now;
    windowStart = Date.now();
    loop.reset();
  };
  const capabilities = {};
  try {
    for (const host of [new URL(SUI).hostname, new URL(DEEP).hostname]) {
      const began = performance.now();
      try {
        capabilities[host] = await Promise.race([
          lookup(host, { all: true }),
          pause(10000, control.signal).then(() => {
            throw Error("REQUEST_TIMEOUT");
          }),
        ]);
        emit({
          kind: "dns-capability",
          at: Date.now(),
          host,
          addresses: capabilities[host],
          elapsedMs: performance.now() - began,
        });
      } catch (e) {
        capabilities[host] = [];
        emit({
          kind: "dns-capability",
          at: Date.now(),
          host,
          code: safeCode(e),
          elapsedMs: performance.now() - began,
        });
      }
    }
    emit({
      kind: "environment",
      at: Date.now(),
      node: process.version,
      undici: process.versions.undici,
      sourceHash: createHash("sha256")
        .update(
          [
            "cli.mjs",
            "core.mjs",
            "clock.mjs",
            "transports.mjs",
            "package-lock.json",
          ]
            .map((f) => readFileSync(new URL(f, import.meta.url)))
            .join("\n"),
        )
        .digest("hex"),
      sdkVersion: "2.37.0",
      platform: process.platform,
      arch: process.arch,
      plan: plan(),
      startAt,
      endAt: startAt + LIMITS.durationMs,
      dnsServers: dns.getServers(),
      autoSelectFamily: net.getDefaultAutoSelectFamily(),
      familyAttemptTimeoutMs: net.getDefaultAutoSelectFamilyAttemptTimeout(),
      proxyEnvNames: Object.keys(process.env).filter((k) =>
        /^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_options)$/i.test(
          k,
        ),
      ),
      resolvers:
        process.platform === "linux"
          ? readFileSync("/etc/resolv.conf", "utf8")
              .split("\n")
              .filter((x) => /^(nameserver|options)/.test(x))
          : null,
      controlledTransport:
        "Undici Agent connections=1 or node:http2; default-fetch is a separate baseline",
    });
    writeFileSync(
      join(out, "ready.json"),
      JSON.stringify({
        runId: args.runId,
        side: args.side,
        node: process.version,
        capabilities,
      }),
    );
    if (Date.now() > startAt) throw Error("SETUP_MISSED_START");
    resources = setInterval(() => {
      try {
        sample();
      } catch {
        stop("EVIDENCE_WRITE_FAILED");
      }
    }, 5000);
    stopWatch = setInterval(() => {
      if (existsSync(stopFile(out))) stop("USER_STOP");
    }, 500);
    const actualStart = await window.start(control.signal);
    emit({
      kind: "measurement-start",
      at: actualStart.wallMs,
      clock: actualStart,
    });
    const anchor = actualStart.monotonicMs;
    deadline = window
      .waitEnd(control.signal)
      .then(() => stop("RUN_DEADLINE"))
      .catch((e) => {
        if (!control.signal.aborted) stop(safeCode(e));
      });
    let failures = 0,
      lastSuccessAt = anchor,
      attempts = 0;
    for (let slot = 0; slot < LIMITS.durationMs / LIMITS.intervalMs; slot++) {
      const due = anchor + slot * LIMITS.intervalMs;
      if (performance.now() > due + LIMITS.intervalMs) {
        emit({ kind: "skipped-slot", slot, at: Date.now(), reason: "OVERDUE" });
        continue;
      }
      await waitUntil(null, due, control.signal);
      control.signal.throwIfAborted();
      const profile = PROFILES[slot % PROFILES.length],
        host = new URL(profile.target === "sui" ? SUI : DEEP).hostname;
      const stale = cycleStop({
        failures,
        lastSuccessAt,
        now: performance.now(),
      });
      if (stale) {
        stop(stale);
        break;
      }
      if (
        profile.family === 6 &&
        !capabilities[host].some((a) => a.family === 6)
      ) {
        emit({
          kind: "unavailable",
          at: Date.now(),
          slot,
          profile,
          reason: "NO_IPV6_ADDRESS",
        });
        continue;
      }
      const cycleSignal = AbortSignal.any([
        control.signal,
        AbortSignal.timeout(LIMITS.cycleMs),
      ]);
      let success = true,
        status = null;
      for (let index = 0; index < 3; index++) {
        if (index) await pause(LIMITS.spacingMs, cycleSignal);
        cycleSignal.throwIfAborted();
        if (attempts >= LIMITS.maxAttempts) throw Error("ATTEMPT_LIMIT");
        const mode =
          profile.protocol === "default-fetch"
            ? "default"
            : index === 2
              ? "cold"
              : "warm";
        const record = await harness.attempt(profile, mode, cycleSignal);
        attempts++;
        emit({ ...record, slot, index, at: record.endedAt });
        success &&= record.success;
        status = record.httpStatus;
        if (status === 429) {
          stop("RATE_LIMITED");
          break;
        }
        if (!record.success) break; // No per-request retry and no recovery traffic after failure.
      }
      failures = success ? 0 : failures + 1;
      if (success) lastSuccessAt = performance.now();
      emit({
        kind: "cycle",
        at: Date.now(),
        slot,
        profile,
        success,
        failures,
        attempts,
      });
      const why = cycleStop({
        failures,
        lastSuccessAt,
        now: performance.now(),
        status,
      });
      if (why) {
        stop(why);
        break;
      }
    }
    if (!control.signal.aborted) await deadline;
  } catch (e) {
    if (!control.signal.aborted) reason = safeCode(e);
  } finally {
    clearInterval(resources);
    clearInterval(stopWatch);
    const clock = window.snapshot();
    if (!control.signal.aborted) control.abort(Error(reason));
    await deadline;
    try {
      sample();
    } catch {
      reason = "EVIDENCE_WRITE_FAILED";
    }
    loop.disable();
    await harness.close();
    emit({
      kind: "end",
      at: Date.now(),
      reason,
      clock,
      qualityVerdict: "NOT_EVALUATED",
    });
    await emit.flush();
  }
  return { reason, out };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(
      JSON.stringify(await run(argsOf(process.argv.slice(2))), null, 2),
    );
  } catch (e) {
    console.error(safeCode(e));
    process.exitCode = 1;
  }
}
