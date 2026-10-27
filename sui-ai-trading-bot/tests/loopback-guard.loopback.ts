import { it, expect } from "vitest";
import { Socket, createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";

it("refuses external socket destinations before resolving or connecting", () => {
  for (const host of [
    "fullnode.mainnet.sui.io",
    "deepbook-indexer.mainnet.mystenlabs.com",
    "192.0.2.1",
    "::ffff:192.0.2.1",
  ]) {
    const socket = new Socket();
    try {
      expect(() => socket.connect({ port: 443, host })).toThrow(
        "LOOPBACK_ONLY_CONNECT_BLOCKED",
      );
    } finally {
      socket.destroy();
    }
  }
});

it("refuses wildcard and non-loopback listeners", () => {
  for (const host of [undefined, "0.0.0.0", "::", "192.0.2.1"]) {
    const server = createServer();
    expect(() => server.listen({ port: 0, host })).toThrow(
      "LOOPBACK_ONLY_LISTEN_BLOCKED",
    );
    expect(server.listening).toBe(false);
  }
});

it("inherits the loopback restriction in isolated worker processes", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { Socket } from 'node:net';
    try { new Socket().connect({host:'192.0.2.1',port:443}); process.exit(2); }
    catch (error) { if(error.message !== 'LOOPBACK_ONLY_CONNECT_BLOCKED') process.exit(3); }
  `,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
});

it("inherits the guard in chart-history style worker threads with empty execArgv", async () => {
  const worker = new Worker(
    `
    const { parentPort } = require('node:worker_threads');
    const { Socket } = require('node:net');
    // Inspect installation without attempting a network request if absent.
    parentPort.postMessage(Boolean(globalThis[Symbol.for('suiba.loopback-guard')]) &&
      Socket.prototype.connect.toString().includes('LOOPBACK_ONLY_CONNECT_BLOCKED'));
  `,
    { eval: true, execArgv: [] },
  );
  try {
    const installed = await new Promise<boolean>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    expect(installed).toBe(true);
  } finally {
    await worker.terminate();
  }
});
