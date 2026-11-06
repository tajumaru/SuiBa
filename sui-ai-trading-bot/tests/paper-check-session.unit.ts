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

it("requires a single explicit SUI-only production arm without a deadline", () => {
  let mono = 10,
    wall = 1000;
  const session = new PaperCheckSession(
    "sui-prod",
    () => mono,
    () => wall,
  );
  expect(session.status()).toEqual({
    enabled: true,
    armed: false,
    expired: false,
    expires: null,
  });
  expect(session.ordersAllowed("SUI_USDC")).toBe(false);
  expect(session.pairAllowed("WAL_USDC")).toBe(false);
  expect(() => session.arm("WAL_USDC", undefined, wall)).toThrow();
  expect(() => session.arm("SUI_USDC", wall + 1000, wall)).toThrow();
  session.arm("SUI_USDC", undefined, wall);
  expect(session.status()).toEqual({
    enabled: true,
    armed: true,
    expired: false,
    expires: null,
  });
  expect(session.ordersAllowed("SUI_USDC")).toBe(true);
  expect(session.ordersAllowed("WAL_USDC")).toBe(false);
  expect(() => session.arm("SUI_USDC", undefined, wall)).toThrow();
  mono += 7 * 24 * 60 * 60 * 1000;
  wall += 7 * 24 * 60 * 60 * 1000;
  expect(session.expired()).toBe(false);
  expect(session.ordersAllowed("SUI_USDC")).toBe(true);
  const rebooted = new PaperCheckSession(
    "sui-prod",
    () => mono,
    () => wall,
  );
  expect(rebooted.ordersAllowed("SUI_USDC")).toBe(false);
});

it("rejects missing, skewed or non-finite production issue times and explicit null deadlines", () => {
  for (const issued of [undefined, null, NaN, Infinity, 3100, -3000, 100.5]) {
    const session = new PaperCheckSession(
      "sui-prod",
      () => 0,
      () => 100,
    );
    expect(() =>
      session.arm("SUI_USDC", undefined, issued as number),
    ).toThrow();
    expect(session.status().armed).toBe(false);
  }
  const session = new PaperCheckSession(
    "sui-prod",
    () => 0,
    () => 100,
  );
  expect(() =>
    session.arm("SUI_USDC", null as unknown as number, 100),
  ).toThrow();
});

it("irreversibly closes production authorization on either clock regressing or becoming non-finite", () => {
  for (const clock of ["mono", "wall"] as const) {
    for (const invalid of [99, NaN, Infinity, -Infinity]) {
      for (const armed of [false, true]) {
        let mono = 100,
          wall = 100;
        const session = new PaperCheckSession(
          "sui-prod",
          () => mono,
          () => wall,
        );
        if (armed) session.arm("SUI_USDC", undefined, wall);
        if (clock === "mono") mono = invalid;
        else wall = invalid;
        expect(session.expired()).toBe(true);
        expect(session.ordersAllowed("SUI_USDC")).toBe(false);
        mono = wall = 200;
        expect(session.expired()).toBe(true);
        expect(() => session.arm("SUI_USDC", undefined, wall)).toThrow();
      }
    }
  }
});

it("never accepts an unbounded arm in verification or ordinary PAPER", () => {
  for (const mode of [undefined, "sui-30m"]) {
    const session = new PaperCheckSession(
      mode,
      () => 0,
      () => 100,
    );
    expect(() => session.arm("SUI_USDC", undefined, 100)).toThrow();
    expect(session.status().armed).toBe(false);
  }
});

it("does not recover production authorization from invalid initial clock samples", () => {
  for (const initial of [NaN, Infinity, -Infinity]) {
    for (const clock of ["mono", "wall"] as const) {
      let mono = clock === "mono" ? initial : 100;
      let wall = clock === "wall" ? initial : 100;
      const session = new PaperCheckSession(
        "sui-prod",
        () => mono,
        () => wall,
      );
      mono = wall = 200;
      expect(session.expired()).toBe(true);
      expect(() => session.arm("SUI_USDC", undefined, wall)).toThrow();
    }
  }
});
