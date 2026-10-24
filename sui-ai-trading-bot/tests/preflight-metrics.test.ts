import { expect, it } from "vitest";
import { installPreflightMetrics } from "../scripts/preflight-passive-metrics.mjs";
it("measures synchronous persistence without changing acknowledgement or exposing values", () => {
  class Fixture {
    saved = false;
    append(_value: string) {
      this.saved = true;
      return "committed";
    }
    set() {}
    transaction(fn: () => unknown) {
      return fn();
    }
  }
  const original = Fixture.prototype.append,
    events: any[] = [];
  const metrics = installPreflightMetrics(Fixture.prototype, (event) =>
    events.push(event),
  );
  try {
    const fixture = new Fixture();
    expect(fixture.append("private fixture value")).toBe("committed");
    expect(fixture.saved).toBe(true);
    metrics.sample();
    expect(events[0].sqlite.append.count).toBe(1);
    fixture.append("second private fixture");
    metrics.sample();
    expect(events[1].scope).toBe("CUMULATIVE");
    expect(events[1].sqlite.append.count).toBe(2);
    expect(JSON.stringify(events)).not.toContain("private");
  } finally {
    metrics.stop();
  }
  expect(Fixture.prototype.append).toBe(original);
});
it("preserves thrown BUSY and counts nested errors once without retry", () => {
  const busy = Object.assign(Error("private"), { errcode: 5 });
  let calls = 0;
  class Fixture {
    append() {
      calls++;
      throw busy;
    }
    set() {}
    transaction(fn: () => unknown) {
      return fn();
    }
  }
  const events: any[] = [];
  const metrics = installPreflightMetrics(Fixture.prototype, (event) =>
    events.push(event),
  );
  try {
    const db = new Fixture();
    expect(() => db.transaction(() => db.append())).toThrow(busy);
    metrics.sample();
    expect(calls).toBe(1);
    expect(events[0].sqliteBusy).toBe(1);
    expect(events[0].sqlite.transaction.failures).toBe(1);
    expect(events[0].sqlite.append.failures).toBe(1);
    expect(JSON.stringify(events)).not.toContain("private");
  } finally {
    metrics.stop();
  }
});
it("does not hide failed metric persistence and allows deterministic cleanup", () => {
  class Fixture {
    append() {}
    set() {}
    transaction() {}
  }
  const metrics = installPreflightMetrics(Fixture.prototype, () => {
    throw Error("VALIDATION_RECORD_FAILED");
  });
  expect(() => metrics.sample()).toThrow("VALIDATION_RECORD_FAILED");
  metrics.stop();
  metrics.stop();
  expect(() => metrics.sample()).toThrow("METRICS_CLOSED");
});
