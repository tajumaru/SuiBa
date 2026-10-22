import { connect, constants } from "node:http2";
const host = "https://deepbook-indexer.mainnet.mystenlabs.com";
let session = null,
  id = 0;
async function read() {
  const start = performance.now();
  let phase = "CONNECT",
    events = [];
  if (!session || session.closed || session.destroyed) {
    id++;
    session = connect(host);
    const own = session;
    own.on("error", () => {});
    own.socket.on("lookup", () =>
      events.push({ event: "DNS", ms: Math.round(performance.now() - start) }),
    );
    own.socket.on("connect", () => {
      phase = "TLS";
      events.push({ event: "TCP", ms: Math.round(performance.now() - start) });
    });
    own.on("connect", () => {
      phase = "HEADERS";
      events.push({
        event: "HTTP2_CONNECTED",
        ms: Math.round(performance.now() - start),
      });
    });
  } else phase = "HEADERS";
  const current = session;
  await new Promise((resolve) => {
    let bytes = 0,
      done = false,
      status = null;
    const stream = current.request({
      ":path": "/status?max_checkpoint_lag=100&max_time_lag_seconds=60",
      ":method": "GET",
      accept: "application/json",
    });
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      console.log(
        JSON.stringify({
          id,
          phase,
          status,
          error,
          bytes,
          elapsedMs: Math.round(performance.now() - start),
          events,
          at: Date.now(),
        }),
      );
      resolve();
    };
    const timer = setTimeout(() => {
      stream.close(constants.NGHTTP2_CANCEL);
      current.destroy();
      finish("TIMEOUT");
    }, 8000);
    stream.on("response", (h) => {
      status = h[":status"];
      phase = "BODY";
    });
    stream.on("data", (b) => (bytes += b.length));
    stream.on("end", () => finish(null));
    stream.on("error", (e) => finish(e.code));
    stream.on("aborted", () => finish("ABORTED"));
  });
}
for (const wait of [0, 2500, 10000, 60000]) {
  await new Promise((r) => setTimeout(r, wait));
  await read();
}
session?.close();
