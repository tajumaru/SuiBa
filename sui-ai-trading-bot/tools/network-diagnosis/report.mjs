import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stat, LIMITS, assertNode } from "./core.mjs";
export function parse(text) {
  const rows = [];
  let badLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      badLines++;
    }
  }
  return { rows, badLines };
}
export function summarize(inputs) {
  const rows = inputs.flatMap((x) => x.rows),
    attempts = rows.filter((r) => r.kind === "attempt"),
    environments = rows.filter((r) => r.kind === "environment");
  const identity =
    environments.length === 2 &&
    new Set(environments.map((e) => e.runId)).size === 1 &&
    new Set(environments.map((e) => e.side)).size === 2 &&
    new Set(environments.map((e) => e.startAt)).size === 1 &&
    new Set(environments.map((e) => e.sourceHash)).size === 1 &&
    environments.every((e) => {
      try {
        if (typeof e.node !== "string") return false;
        assertNode(e.node);
        return !!e.sourceHash;
      } catch {
        return false;
      }
    }) &&
    rows
      .filter((r) => ["attempt", "end"].includes(r.kind))
      .every(
        (r) =>
          r.runId === environments[0]?.runId &&
          ["windows", "docker"].includes(r.side),
      );
  const comparison = [];
  for (const side of ["windows", "docker"])
    for (const target of ["sui", "deepbook"]) {
      const a = attempts.filter(
        (r) => r.side === side && r.profile.target === target,
      );
      comparison.push({
        side,
        target,
        attempts: a.length,
        success: a.filter((r) => r.success).length,
        timeouts: a.filter((r) => /TIMEOUT|DEADLINE/.test(r.code ?? "")).length,
        latencyMs: stat(a.map((r) => r.timing.totalMs)),
        phases: Object.fromEntries(
          [
            "dnsMs",
            "tcpMs",
            "tlsMs",
            "headersMs",
            "responseWaitMs",
            "bodyMs",
          ].map((k) => [k, stat(a.map((r) => r.timing[k]))]),
        ),
      });
    }
  const profiles = [];
  for (const a of attempts) {
    const key = JSON.stringify([a.side, a.profile, a.mode]);
    let g = profiles.find((p) => p.key === key);
    if (!g) {
      g = {
        key,
        side: a.side,
        profile: a.profile,
        mode: a.mode,
        attempts: 0,
        success: 0,
        actualReused: 0,
        actualNew: 0,
        unknownReuse: 0,
        latencies: [],
      };
      profiles.push(g);
    }
    g.attempts++;
    g.success += a.success ? 1 : 0;
    g.actualReused += a.timing.reusedConnection === true ? 1 : 0;
    g.actualNew += a.timing.reusedConnection === false ? 1 : 0;
    g.unknownReuse += a.timing.reusedConnection == null ? 1 : 0;
    g.latencies.push(a.timing.totalMs);
  }
  const failures = attempts
    .filter((r) => !r.success)
    .map((r) => ({
      side: r.side,
      target: r.profile.target,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      code: r.code,
      phase: r.timing.phase,
      coincident: attempts
        .filter(
          (o) =>
            o !== r &&
            !o.success &&
            o.startedAt <= r.endedAt &&
            o.endedAt >= r.startedAt,
        )
        .map((o) => ({ side: o.side, target: o.profile.target, code: o.code })),
      overlappingResourceSamples: rows
        .filter(
          (o) =>
            o.kind === "resource" &&
            o.windowStart <= r.endedAt &&
            o.windowEnd >= r.startedAt,
        )
        .map((o) => ({
          side: o.side,
          windowStart: o.windowStart,
          windowEnd: o.windowEnd,
          eventLoopMaxMs: o.eventLoopMaxMs,
          cpuPercent: o.cpuPercent,
        })),
    }));
  return {
    schema: 1,
    qualityVerdict: "NOT_EVALUATED",
    limits: LIMITS,
    identityMatched: identity,
    evidenceComplete:
      identity &&
      inputs.every((i) => !i.missing && i.badLines === 0) &&
      ["windows", "docker"].every(
        (side) =>
          attempts.some((a) => a.side === side) &&
          new Set(
            rows
              .filter(
                (r) =>
                  r.side === side &&
                  ["cycle", "unavailable", "skipped-slot"].includes(r.kind) &&
                  Number.isInteger(r.slot) &&
                  r.slot >= 0 &&
                  r.slot < 30,
              )
              .map((r) => r.slot),
          ).size === 30,
      ) &&
      ["windows", "docker"].every((side) =>
        rows.some(
          (r) =>
            r.side === side &&
            r.kind === "end" &&
            r.reason === "RUN_DEADLINE" &&
            r.at >=
              environments.find((e) => e.side === side)?.startAt +
                LIMITS.durationMs,
        ),
      ),
    missingFiles: inputs.filter((i) => i.missing).map((i) => i.missing),
    badLines: inputs.reduce((n, i) => n + i.badLines, 0),
    comparison,
    profiles: profiles.map(({ key, latencies, ...g }) => ({
      ...g,
      latencyMs: stat(latencies),
    })),
    failures,
    environments,
    ends: rows.filter((r) => r.kind === "end"),
    resources: rows.filter((r) => r.kind === "resource"),
    unavailability: rows.filter(
      (r) => r.kind === "unavailable" || r.kind === "collector-status",
    ),
    systemEvents: rows.filter((r) =>
      [
        "windows-dns",
        "windows-wlan",
        "docker-log",
        "host-resource",
        "docker-resource",
        "packet-summary",
      ].includes(r.kind),
    ),
    limitations: [
      "JS/OS event timings are not packet timestamps. Reused DNS/TCP/TLS phases remain null.",
      "Controlled pools are not the production default pool. IPv6 without AAAA is unavailable, not success.",
      "No operational quality verdict; 100-attempt criteria and Bot safety thresholds are unchanged.",
      "Absent logs/packets and missing phases cannot be treated as zero latency or a healthy path.",
    ],
  };
}
export function csv(rows) {
  const fields = [
    "runId",
    "side",
    "kind",
    "at",
    "observedAt",
    "startedAt",
    "endedAt",
    "eventAt",
    "target",
    "requestedProtocol",
    "protocol",
    "requestedFamily",
    "family",
    "mode",
    "success",
    "code",
    "httpStatus",
    "phase",
    "connectionId",
    "reusedConnection",
    "dnsMs",
    "tcpMs",
    "tlsMs",
    "headersMs",
    "responseWaitMs",
    "bodyMs",
    "totalMs",
    "phaseElapsedMs",
    "category",
    "collector",
    "status",
    "reason",
    "query",
    "clientPid",
    "eventId",
    "retransmission",
    "clientHello",
    "serverHello",
    "syn",
    "ack",
    "tcpStream",
  ];
  const quote = (v) => '"' + String(v ?? "").replaceAll('"', '""') + '"';
  return (
    [
      fields,
      ...rows.map((r) => {
        const flat = {
          ...r,
          ...r.profile,
          requestedFamily: r.profile?.family,
          requestedProtocol: r.profile?.protocol,
          ...r.timing,
        };
        return fields.map((k) => flat[k]);
      }),
    ]
      .map((row) => row.map(quote).join(","))
      .join("\n") + "\n"
  );
}
export function markdown(m) {
  const lines = [
    "# Windows / Docker network diagnosis",
    "",
    `Evidence complete: ${m.evidenceComplete}. Quality verdict: NOT_EVALUATED.`,
    "",
    "| Side | Target | Attempts | Success | Timeouts | P50/P95 total ms |",
    "| --- | --- | ---: | ---: | ---: | --- |",
    ...m.comparison.map(
      (c) =>
        `| ${c.side} | ${c.target} | ${c.attempts} | ${c.success} | ${c.timeouts} | ${c.latencyMs.p50 ?? "unknown"} / ${c.latencyMs.p95 ?? "unknown"} |`,
    ),
    "",
    "## Controlled profiles and observed reuse",
    "| Side | Target / transport / requested IP | Mode | Success / attempts | Actual reused / new / unknown | P95 ms |",
    "| --- | --- | --- | --- | --- | --- |",
    ...m.profiles.map(
      (p) =>
        `| ${p.side} | ${p.profile.target} / ${p.profile.protocol} / ${p.profile.family || "auto"} | ${p.mode} | ${p.success}/${p.attempts} | ${p.actualReused}/${p.actualNew}/${p.unknownReuse} | ${p.latencyMs.p95 ?? "unknown"} |`,
    ),
    "",
    "## Cause candidates and evidence",
    ...m.failures.map(
      (f) =>
        `- ${new Date(f.startedAt).toISOString()}: ${f.side}/${f.target}, ${f.code}, phase=${f.phase}; overlapping failures=${f.coincident.length}.`,
    ),
    "- Shared host/upstream route is a candidate only when independent sides/endpoints show correlated delays. Correlation does not identify Wi-Fi, DNS forwarding, proxy, scheduling, or upstream ownership.",
    "- Isolated DNS delays support resolver investigation; TLS completion without headers supports post-TLS investigation. Unknown phases stay unknown.",
    "",
    "## Next steps",
    "- Compare per-profile warm/cold and actual connection IDs/families in network-timeline.csv, rather than assuming reuse.",
    "- Correlate failure windows with resource/event-loop samples, Windows DNS events, Docker logs and optional packet evidence.",
    "- Do not switch DNS, force IPv4, change pools/retries/timeouts, relax safety gates, or start trading from these results.",
    "",
    "## Missing evidence",
    ...m.missingFiles.map((f) => "- " + f),
    "",
    "## Limitations",
    ...m.limitations.map((s) => "- " + s),
    ...m.unavailability.map(
      (r) =>
        `- ${r.side ?? "host"}: ${r.reason ?? r.status ?? "unavailable"} (${r.collector ?? r.kind}).`,
    ),
  ];
  if (!m.failures.length)
    lines.push(
      "- No recorded request failures. This is not proof of long-term reliability.",
    );
  return lines.join("\n") + "\n";
}
export function generate(root) {
  const inputs = [
    "windows/events.jsonl",
    "docker/events.jsonl",
    "system.jsonl",
  ].map((p) => {
    const file = join(root, p);
    return existsSync(file)
      ? parse(readFileSync(file, "utf8"))
      : { rows: [], badLines: 0, missing: p };
  });
  const m = summarize(inputs);
  writeFileSync(
    join(root, "network-metrics.json"),
    JSON.stringify(m, null, 2) + "\n",
  );
  writeFileSync(
    join(root, "network-timeline.csv"),
    csv(
      inputs
        .flatMap((i) => i.rows)
        .sort((a, b) => (a.at ?? a.observedAt) - (b.at ?? b.observedAt)),
    ),
  );
  writeFileSync(join(root, "network-diagnosis.md"), markdown(m));
  return m;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3)
    throw Error("Usage: node report.mjs <existing-run-folder>");
  console.log(
    JSON.stringify({
      generated: resolve(process.argv[2]),
      complete: generate(resolve(process.argv[2])).evidenceComplete,
    }),
  );
}
