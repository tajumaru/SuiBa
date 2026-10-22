// Read-only, bounded public endpoint probe. No credentials or response bodies are logged.
import https from "node:https";
import dns from "node:dns/promises";

const host = "deepbook-indexer.mainnet.mystenlabs.com",
  url = `https://${host}/status?max_checkpoint_lag=100&max_time_lag_seconds=60`;
let events = [],
  began = 0;
const addresses = await dns.lookup(host, { all: true });
console.log(
  JSON.stringify({
    event: "environment",
    node: process.version,
    addresses,
    at: Date.now(),
  }),
);
for (const method of ["fetch", "https", "fetch", "https", "fetch", "https"]) {
  began = performance.now();
  events = [];
  try {
    let status,
      bytes = 0;
    if (method === "fetch") {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      status = r.status;
      bytes = (await r.arrayBuffer()).byteLength;
    } else
      await new Promise((resolve, reject) => {
        const req = https.get(
          url,
          { agent: false, signal: AbortSignal.timeout(8000) },
          (r) => {
            status = r.statusCode;
            events.push({
              event: "headers",
              ms: Math.round(performance.now() - began),
            });
            r.on("data", (b) => (bytes += b.length));
            r.on("end", resolve);
            r.on("error", reject);
          },
        );
        req.on("socket", (s) => {
          s.on("lookup", () =>
            events.push({
              event: "dns",
              ms: Math.round(performance.now() - began),
            }),
          );
          s.on("connect", () =>
            events.push({
              event: "tcp",
              ms: Math.round(performance.now() - began),
              ip: s.remoteAddress,
            }),
          );
          s.on("secureConnect", () =>
            events.push({
              event: "tls",
              ms: Math.round(performance.now() - began),
            }),
          );
        });
        req.on("error", reject);
      });
    console.log(
      JSON.stringify({
        method,
        status,
        bytes,
        elapsedMs: Math.round(performance.now() - began),
        events,
        at: Date.now(),
      }),
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        method,
        error: e.name,
        code: e.cause?.code ?? e.code,
        elapsedMs: Math.round(performance.now() - began),
        events,
        at: Date.now(),
      }),
    );
  }
  await new Promise((r) => setTimeout(r, 2500));
}
