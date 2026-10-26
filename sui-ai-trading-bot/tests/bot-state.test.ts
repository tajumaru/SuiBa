import { expect, it } from "vitest";
import { botControlState } from "../packages/shared/src/bot-state.ts";
const normal = {
  running: true,
  error: null,
  emergency: false,
  databaseHealthy: true,
  connectivity: "HEALTHY",
  resumePending: false,
  ordersAllowed: true,
};

it("maps all five operational states without granting orders", () => {
  expect(botControlState(normal)).toBe("RUNNING");
  expect(
    botControlState({
      ...normal,
      running: false,
      resumePending: true,
      connectivity: "DEGRADED",
      ordersAllowed: false,
    }),
  ).toBe("DEGRADED");
  expect(
    botControlState({
      ...normal,
      running: false,
      resumePending: true,
      connectivity: "RECOVERING",
      ordersAllowed: false,
    }),
  ).toBe("PAUSED");
  expect(botControlState({ ...normal, ordersAllowed: false })).toBe("PAUSED");
  expect(
    botControlState({
      ...normal,
      running: false,
      connectivity: "DEGRADED",
      ordersAllowed: false,
    }),
  ).toBe("STOPPED");
});
it.each([
  { error: "MARKET_DATA_STALLED" },
  { emergency: true },
  { databaseHealthy: false },
])("faults take precedence over running and recovery intent: %j", (fault) => {
  expect(botControlState({ ...normal, ...fault, resumePending: true })).toBe(
    "FAULTED",
  );
});
it("unknown connectivity fails closed to PAUSED", () => {
  expect(botControlState({ ...normal, connectivity: "unknown" })).toBe(
    "PAUSED",
  );
});
