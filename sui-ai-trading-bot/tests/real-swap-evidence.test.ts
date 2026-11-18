import { describe, expect, it, vi } from "vitest";
import { minOutFromQuote, runSwap, swapRoute } from "../scripts/real-swap.ts";
import { phase1Checklist } from "../scripts/real-phase1-evidence.ts";
import type { RealHistoryEvent, RealIdentity } from "../apps/worker/src/real/types.ts";

const identity: RealIdentity = {
  network: "testnet", balanceManagerId: "bm", poolKey: "SUI_DBUSDC", tradeCapId: "cap",
  signerAddress: "signer", sessionId: "phase1",
};
const event = (kind: RealHistoryEvent["kind"], digest: string): RealHistoryEvent => ({
  chain: "sui:testnet", checkpoint: "1", digest, eventSequence: `${kind}:1`, kind, identity, raw: {},
});

describe("REAL testnet swap", () => {
  it("floors minOut at output precision and rejects unsafe slippage", () => {
    expect(minOutFromQuote(9.9999999, 50)).toBe(9.949999);
    expect(() => minOutFromQuote(10, 1001)).toThrow("REAL_SWAP_GUARD_INVALID");
  });
  it("fixes both SUI pool directions", () => {
    expect(swapRoute("DBUSDC")).toEqual({ poolKey: "SUI_DBUSDC", direction: "BASE_TO_QUOTE" });
    expect(swapRoute("DEEP")).toEqual({ poolKey: "DEEP_SUI", direction: "QUOTE_TO_BASE" });
  });
  it("never sends in the default dry-run", async () => {
    const execute = vi.fn(async () => "digest");
    const result = await runSwap(
      { REAL_SWAP_AMOUNT_SUI: "1", REAL_SWAP_MAX_SUI: "2" }, ["--target=DBUSDC"],
      { quote: async () => ({ out: 0.99, deepRequired: 0 }), execute, output: vi.fn() },
    );
    expect(result.digest).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("Phase 1 evidence checklist", () => {
  it("derives order evidence from ledger fixtures and verifies manifest digests on chain", () => {
    const events = [event("ORDER_PLACED", "place"), event("ORDER_FILLED", "fill"), event("TX_EFFECTS", "bm")];
    const result = phase1Checklist(events, { balanceManagerCreated: ["bm"], depositSui: ["missing"] });
    expect(result.find((row) => row.key === "orderPlaced")?.status).toBe("あり");
    expect(result.find((row) => row.key === "orderFilled")?.status).toBe("あり");
    expect(result.find((row) => row.key === "balanceManagerCreated")?.status).toBe("あり");
    expect(result.find((row) => row.key === "depositSui")?.status).toBe("なし");
    expect(result.find((row) => row.key === "stopResumeS4")?.status).toBe("なし");
  });
});
