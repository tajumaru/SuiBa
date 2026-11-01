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
  expect(() => session.arm("WAL_USDC")).toThrow();
  session.arm("SUI_USDC");
  expect(session.ordersAllowed("SUI_USDC")).toBe(true);
  expect(session.ordersAllowed("WAL_USDC")).toBe(false);
  expect(() => session.arm("SUI_USDC")).toThrow();
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
    session.arm("SUI_USDC");
    if (kind === "wall") wall += 1800000;
    else mono = 99;
    expect(session.ordersAllowed("SUI_USDC")).toBe(false);
  }
});
