import { expect, it } from "vitest";
import { LoginAttempts } from "../apps/dashboard/src/loginAttempt.ts";

it("blocks same-task duplicate starts before a React render", () => {
  const attempts = new LoginAttempts();
  const first = attempts.begin()!;
  expect(attempts.begin()).toBeNull();
  expect(attempts.release(first)).toBe(true);
  expect(attempts.begin()).not.toBeNull();
});

it("ignores stale results in either arrival order without releasing the newer attempt", () => {
  for (const staleFirst of [true, false]) {
    const attempts = new LoginAttempts();
    const old = attempts.begin()!;
    attempts.invalidate();
    expect(old.signal.aborted).toBe(true);
    const next = attempts.begin()!;
    const stale = () => {
      expect(attempts.release(old)).toBe(false);
      expect(attempts.complete(old)).toBe(false);
    };
    if (staleFirst) stale();
    expect(attempts.complete(next)).toBe(true);
    if (!staleFirst) stale();
    expect(attempts.complete(next)).toBe(false);
    expect(attempts.begin()).toBeNull();
  }
});

it("invalidates pending success callbacks on cancel or unmount", () => {
  const attempts = new LoginAttempts();
  const pending = attempts.begin()!;
  attempts.invalidate();
  expect(attempts.complete(pending)).toBe(false);
  expect(attempts.begin()).not.toBeNull();
});
