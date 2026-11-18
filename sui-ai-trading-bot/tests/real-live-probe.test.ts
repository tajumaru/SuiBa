import { describe, expect, it, vi } from "vitest";
import {
  continueAfterRealLiveProbe,
  runRealLiveProbe,
} from "../apps/worker/src/real/runtime.ts";

const passing = () => ({
  snapshot: vi.fn(async () => ({})),
  capValid: vi.fn(async () => true),
  historyPage: vi.fn(async () => ({})),
});

describe("REAL startup live probe", () => {
  it.each([
    [
      "snapshot",
      (reads: ReturnType<typeof passing>) =>
        reads.snapshot.mockRejectedValue(Error("snapshot down")),
    ],
    [
      "cap",
      (reads: ReturnType<typeof passing>) =>
        reads.capValid.mockResolvedValue(false),
    ],
    [
      "history",
      (reads: ReturnType<typeof passing>) =>
        reads.historyPage.mockRejectedValue(Error("history down")),
    ],
  ] as const)(
    "aborts before the first cycle when %s fails",
    async (name, fail) => {
      const reads = passing();
      const cycle = vi.fn();
      fail(reads);

      await expect(
        continueAfterRealLiveProbe(
          { liveProbe: () => runRealLiveProbe(reads) },
          cycle,
        ),
      ).rejects.toThrow(`REAL_LIVE_PROBE_FAILED probe=${name}`);
      expect(cycle).not.toHaveBeenCalled();
    },
  );

  it("allows startup after all three production reads pass", async () => {
    const reads = passing();
    const cycle = vi.fn();

    await continueAfterRealLiveProbe(
      { liveProbe: () => runRealLiveProbe(reads) },
      cycle,
    );

    expect(cycle).toHaveBeenCalledOnce();
    expect(reads.snapshot).toHaveBeenCalledOnce();
    expect(reads.capValid).toHaveBeenCalledOnce();
    expect(reads.historyPage).toHaveBeenCalledOnce();
  });

  it("does not add the REAL probe to PAPER startup", async () => {
    const cycle = vi.fn();

    await continueAfterRealLiveProbe(undefined, cycle);

    expect(cycle).toHaveBeenCalledOnce();
  });
});
