import { beforeEach, afterEach, vi } from "vitest";
// Unit/integration tests must never fall back to live RPC, Aggregator, or market APIs.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("TEST_NETWORK_FORBIDDEN");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
