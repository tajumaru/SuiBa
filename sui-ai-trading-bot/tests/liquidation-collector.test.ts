import { describe, expect, it, vi } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  LiquidationCollector,
  parseForceOrder,
} from "../apps/worker/src/liquidation-collector.ts";

class FakeSocket {
  listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  addEventListener(
    name: string,
    listener: (event: { data?: unknown }) => void,
  ) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string, data?: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener({ data });
  }
  close() {}
}

const message = (side: "BUY" | "SELL", at: number, price = "2", qty = "3") =>
  JSON.stringify({ e: "forceOrder", o: { S: side, T: at, ap: price, z: qty } });

describe("liquidation collector", () => {
  it("maps forced sells to longs, buys to shorts, and keeps exact 5-minute boundaries", () => {
    expect(parseForceOrder(message("SELL", 300_000))).toEqual({
      timestamp: 300_000,
      side: "long",
      notionalUsd: 6,
    });
    const db = new BotDatabase(":memory:");
    db.addLiquidation({ timestamp: 599_999, side: "long", notionalUsd: 10 });
    db.addLiquidation({ timestamp: 600_000, side: "short", notionalUsd: 20 });
    expect(db.liquidationBuckets()).toEqual([
      { bucketAt: 300, longUsd: 10, shortUsd: 0, count: 1 },
      { bucketAt: 600, longUsd: 0, shortUsd: 20, count: 1 },
    ]);
    db.close();
  });

  it("reconnects silently and leaves the disconnected interval visible in coverage", () => {
    const db = new BotDatabase(":memory:");
    const sockets: FakeSocket[] = [];
    const queued: (() => void)[] = [];
    let now = 1_000;
    const collector = new LiquidationCollector(
      db,
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      () => now,
      (fn) => {
        queued.push(fn);
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
    ).start();
    sockets[0]!.emit("open");
    now = 2_000;
    sockets[0]!.emit("close");
    now = 5_000;
    queued.shift()!();
    sockets[1]!.emit("open");
    const status = collector.status(6_000);
    expect(status).toMatchObject({
      connected: true,
      coveredMs: 2_000,
      gapMs: 3_000,
      gaps: 1,
    });
    collector.stop();
    db.close();
  });

  it("retains the restart downtime as a gap and prunes data on the shared 30-day policy", () => {
    const db = new BotDatabase(":memory:");
    db.recordLiquidationCoverage("connected", 100, 1_000);
    db.addLiquidation({ timestamp: 1_000, side: "long", notionalUsd: 1 });
    const socket = new FakeSocket();
    const collector = new LiquidationCollector(db, () => socket, () => 5_000).start();
    socket.emit("open");
    expect(collector.status(5_000)).toMatchObject({ gapMs: 4_000, gaps: 1 });
    db.pruneLiquidations(31 * 86_400_000);
    expect(db.liquidationBuckets()).toEqual([]);
    collector.stop();
    db.close();
  });

  it("cannot interrupt an independent trading tick when setup fails", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const db = new BotDatabase(":memory:");
    expect(() =>
      new LiquidationCollector(db, () => {
        throw new Error("offline");
      }).start(),
    ).not.toThrow();
    await tick();
    expect(tick).toHaveBeenCalledOnce();
    db.close();
  });
});
