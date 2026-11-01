import { expect, it } from "vitest";
import { PaperCheckSession } from "../apps/worker/src/paper-check-session.ts";

it("leaves ordinary PAPER unchanged", () => {
  const session = new PaperCheckSession(undefined);
  expect(session.ordersAllowed("SUI_USDC")).toBe(true);
  expect(session.pairAllowed("WAL_USDC")).toBe(true);
  expect(() => new PaperCheckSession("LIVE")).toThrow();
});

it("requires a single SUI-only lease and expires at exactly 30 minutes", () => {
  let mono = 10,
    wall = 1000;
  const session = new PaperCheckSession(
    "sui-30m",
    () => mono,
    () => wall,
  );
  expect(session.ordersAllowed("SUI_USDC")).toBe(false);
  expect(session.pairAllowed("WAL_USDC")).toBe(false);
  expect(() => session.arm("WAL_USDC", wall + 1800000, wall)).toThrow();
  session.arm("SUI_USDC", wall + 1800000, wall);
  expect(session.ordersAllowed("SUI_USDC")).toBe(true);
  expect(session.ordersAllowed("WAL_USDC")).toBe(false);
  expect(() => session.arm("SUI_USDC", wall + 1800000, wall)).toThrow();
  mono += 1800000;
  expect(session.ordersAllowed("SUI_USDC")).toBe(false);
  mono = 20;
  wall = 0;
  expect(session.ordersAllowed("SUI_USDC")).toBe(false);
});

it("fails closed on wall clock expiry and monotonic regression", () => {
  for (const kind of ["wall", "regression"] as const) {
    let mono = 100,
      wall = 100;
    const session = new PaperCheckSession(
      "sui-30m",
      () => mono,
      () => wall,
    );
    session.arm("SUI_USDC", wall + 1800000, wall);
    if (kind === "wall") wall += 1800000;
    else mono = 99;
    expect(session.ordersAllowed("SUI_USDC")).toBe(false);
  }
});

it("uses the controller cutoff without extending it for preparation or rearm", () => {
  let mono = 0,
    wall = 10000;
  const cutoff = wall + 1800000;
  const session = new PaperCheckSession(
    "sui-30m",
    () => mono,
    () => wall,
  );
  wall += 60000;
  mono += 60000;
  session.arm("SUI_USDC", cutoff, wall);
  expect(session.status().expires).toBe(cutoff);
  expect(() => session.arm("SUI_USDC", cutoff + 60000, wall)).toThrow();
  mono += 1739999;
  wall = cutoff - 1;
  expect(session.ordersAllowed("SUI_USDC")).toBe(true);
  wall = cutoff;
  expect(session.ordersAllowed("SUI_USDC")).toBe(false);
  wall = cutoff + 1;
  expect(session.ordersAllowed("SUI_USDC")).toBe(false);
});
it("rejects skew, expired preparation, invalid deadlines and backward wall clocks", () => {
  for (const [cutoff, issued] of [
    [100, 100],
    [1800101, 100],
    [200, 3100],
    [200, -3000],
    [NaN, 100],
  ]) {
    const session = new PaperCheckSession(
      "sui-30m",
      () => 0,
      () => 100,
    );
    expect(() => session.arm("SUI_USDC", cutoff, issued)).toThrow();
  }
  let wall = 100;
  const session = new PaperCheckSession(
    "sui-30m",
    () => 0,
    () => wall,
  );
  session.arm("SUI_USDC", 200, 100);
  wall = 99;
  expect(session.ordersAllowed("SUI_USDC")).toBe(false);
});
