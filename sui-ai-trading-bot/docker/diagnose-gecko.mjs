// Standalone diagnostic: one public API request by default; no DB or trading.
import dns from "node:dns/promises";
import tls from "node:tls";
import https from "node:https";
import { channel } from "node:diagnostics_channel";
const args = process.argv.slice(2);
const input = args.find((x) => !x.startsWith("--"));
if (!input) {
  console.error(
    "Usage: node docker/diagnose-gecko.mjs <public-Gecko-URL> [--dns-only|--tls-only|--ipv4|--ipv6]",
  );
  process.exit(2);
}
const url = new URL(input);
const safeValues = {
  aggregate: ["1", "5", "15"],
  limit: ["1000"],
  currency: ["token"],
  token: ["base", "quote"],
  include_empty_intervals: ["false"],
  include: ["base_token,quote_token"],
  page: ["1"],
};
const publicPath =
  /^\/api\/v2\/networks\/(?:sui|sui-network)\/(?:pools(?:\/0x[a-f0-9]{64}(?:\/ohlcv\/(?:minute|hour))?)?|tokens\/0x2%3A%3Asui%3A%3ASUI\/pools)$/i;
if (
  url.protocol !== "https:" ||
  url.hostname !== "api.geckoterminal.com" ||
  url.port ||
  url.username ||
  url.password ||
  url.hash ||
  !publicPath.test(url.pathname) ||
  [...url.searchParams].some(
    ([key, value]) => !safeValues[key]?.includes(value),
  )
)
  throw new Error(
    "Only public GeckoTerminal API URLs without credentials are accepted",
  );

const emit = (value) => console.log(JSON.stringify(value));
const codes = (e) => ({
  error: ["AbortError", "TimeoutError", "TypeError", "Error"].includes(e?.name)
    ? e.name
    : "Error",
  code: typeof e?.code === "string" ? e.code : null,
  causeCode: typeof e?.cause?.code === "string" ? e.cause.code : null,
});
emit({ node: process.version, host: url.host, method: "GET", url: url.href });
for (const key of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
])
  emit({ setting: key, present: !!process.env[key] });
let addresses = [];
for (const [probe, fn] of [
  ["lookup", () => dns.lookup(url.hostname, { all: true })],
  ["A", () => dns.resolve4(url.hostname)],
  ["AAAA", () => dns.resolve6(url.hostname)],
]) {
  const t = performance.now();
  try {
    const result = await fn();
    if (probe === "lookup") addresses = result;
    emit({ probe, result, ms: Math.round(performance.now() - t) });
  } catch (e) {
    emit({ probe, ...codes(e), ms: Math.round(performance.now() - t) });
  }
}
if (args.includes("--dns-only")) process.exit(0);
if (args.includes("--tls-only")) {
  for (const { address, family } of addresses)
    await new Promise((resolve) => {
      const t = performance.now();
      const socket = tls.connect({
        host: address,
        family,
        port: 443,
        servername: url.hostname,
        rejectUnauthorized: true,
      });
      const timer = setTimeout(() => {
        emit({
          probe: "TLS",
          address,
          family,
          error: "HANDSHAKE_TIMEOUT",
          ms: Math.round(performance.now() - t),
        });
        socket.destroy();
        resolve();
      }, 5000);
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        emit({
          probe: "TLS",
          address,
          family,
          authorized: socket.authorized,
          protocol: socket.getProtocol(),
          ms: Math.round(performance.now() - t),
        });
        socket.destroy();
        resolve();
      });
      socket.once("error", (e) => {
        clearTimeout(timer);
        emit({
          probe: "TLS",
          address,
          family,
          ...codes(e),
          ms: Math.round(performance.now() - t),
        });
        resolve();
      });
    });
  process.exit(0);
}
if (args.includes("--ipv4") || args.includes("--ipv6")) {
  const family = args.includes("--ipv4") ? 4 : 6;
  if (!addresses.some((a) => a.family === family)) {
    emit({ probe: "HTTPS", family, result: "SKIPPED_NO_ADDRESS" });
    process.exit(0);
  }
  const t = performance.now();
  const phases = [];
  await new Promise((resolve) => {
    const req = https.get(
      url,
      {
        family,
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      },
      (res) => {
        phases.push({
          phase: "headers",
          ms: Math.round(performance.now() - t),
        });
        res.resume();
        res.once("end", () => {
          emit({
            probe: "HTTPS",
            family,
            status: res.statusCode,
            ms: Math.round(performance.now() - t),
            phases,
          });
          resolve();
        });
        res.once("error", (e) => {
          emit({ probe: "HTTPS_BODY", family, ...codes(e), phases });
          resolve();
        });
      },
    );
    req.on("socket", (s) => {
      for (const event of ["lookup", "connect", "secureConnect"])
        s.once(event, () =>
          phases.push({ phase: event, ms: Math.round(performance.now() - t) }),
        );
    });
    req.once("error", (e) => {
      emit({
        probe: "HTTPS",
        family,
        ...codes(e),
        ms: Math.round(performance.now() - t),
        phases,
      });
      resolve();
    });
  });
} else {
  const t = performance.now();
  const phases = [];
  for (const event of ["beforeConnect", "connected", "connectError"])
    channel(`undici:client:${event}`).subscribe((x) =>
      phases.push({
        phase: event,
        ms: Math.round(performance.now() - t),
        code: x.error?.code,
        family: x.socket?.remoteFamily,
        ip: x.socket?.remoteAddress,
      }),
    );
  let phase = "HEADERS_OR_CONNECT";
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { accept: "application/json" },
    });
    phase = "BODY";
    const headerMs = Math.round(performance.now() - t);
    await r.arrayBuffer();
    emit({
      probe: "fetch",
      status: r.status,
      retryAfter: r.headers.get("retry-after"),
      headerMs,
      ms: Math.round(performance.now() - t),
      phases,
    });
  } catch (e) {
    emit({
      probe: "fetch",
      phase,
      ...codes(e),
      ms: Math.round(performance.now() - t),
      phases,
    });
  }
}
