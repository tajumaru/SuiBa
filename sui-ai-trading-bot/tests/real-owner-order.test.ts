import { describe, expect, it, vi } from "vitest";
import {
  phase1S2ClientOrderId,
  runOwnerOrder,
  type OwnerOrderDependencies,
} from "../scripts/real-owner-order.ts";

const encodedOrderId = (isBid: boolean, rawPrice: bigint, sequence = 1n) =>
  (((isBid ? 0n : 1n) << 127n) | (rawPrice << 64n) | sequence).toString();

const dependencies = (
  overrides: Partial<OwnerOrderDependencies> = {},
): OwnerOrderDependencies => ({
  snapshot: vi.fn(async () => ({
    book: { bid_prices: [1], ask_prices: [1.1] },
    orderDetails: [],
  })),
  place: vi.fn(async () => ({ orderId: "123", digest: "place-digest" })),
  cancel: vi.fn(async () => "cancel-digest"),
  output: vi.fn(),
  ...overrides,
});

describe("REAL owner resting order", () => {
  it("prints a dry-run plan without signing", async () => {
    const deps = dependencies();
    const result = await runOwnerOrder(
      {},
      ["--side", "BUY", "--price", "0.5", "--quantity", "0.5"],
      deps,
    );
    expect(deps.place).not.toHaveBeenCalled();
    expect(deps.output).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "DRY_RUN", totalValue: 0.25 }),
    );
    expect(result.digest).toBeNull();
  });

  it("refuses BUY prices at the resting threshold without signing", async () => {
    const deps = dependencies();
    await expect(
      runOwnerOrder(
        {},
        ["--execute", "--side", "BUY", "--price", "0.99", "--quantity", "0.5"],
        deps,
      ),
    ).rejects.toThrow("REAL_OWNER_ORDER_BUY_NOT_RESTING");
    expect(deps.place).not.toHaveBeenCalled();
  });

  it.each([
    [
      ["--side", "BUY", "--price", "0.5", "--quantity", "1.000000001"],
      "QUANTITY_CAP",
    ],
    [["--side", "SELL", "--price", "2", "--quantity", "0.6"], "VALUE_CAP"],
  ])("refuses %s above a size cap", async (argv, error) => {
    const deps = dependencies();
    await expect(runOwnerOrder({}, argv, deps)).rejects.toThrow(error);
    expect(deps.place).not.toHaveBeenCalled();
  });

  it("fails closed when the live book read fails", async () => {
    const deps = dependencies({
      snapshot: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await expect(
      runOwnerOrder(
        {},
        ["--execute", "--side", "BUY", "--price", "0.5", "--quantity", "0.5"],
        deps,
      ),
    ).rejects.toThrow("REAL_OWNER_ORDER_BOOK_READ_FAILED");
    expect(deps.place).not.toHaveBeenCalled();
  });

  it("places with the deterministic phase1-s2 client id", async () => {
    const deps = dependencies();
    const result = await runOwnerOrder(
      {},
      ["--execute", "--side", "BUY", "--price", "0.5", "--quantity", "0.5"],
      deps,
    );
    expect(deps.place).toHaveBeenCalledWith(
      expect.objectContaining({
        clientOrderId: expect.stringMatching(/^phase1-s2:/),
      }),
    );
    expect(deps.output).toHaveBeenLastCalledWith({
      state: "SENT",
      orderId: "123",
      digest: "place-digest",
    });
    expect(result).toMatchObject({ orderId: "123", digest: "place-digest" });
  });

  it("cancels exactly the requested order id", async () => {
    const deps = dependencies();
    await runOwnerOrder({}, ["--cancel", "987654321"], deps);
    expect(deps.cancel).toHaveBeenCalledOnce();
    expect(deps.cancel).toHaveBeenCalledWith("987654321");
  });

  it("renders current snapshot orders", async () => {
    const clientId = phase1S2ClientOrderId("BUY", "0.5", "0.5");
    const deps = dependencies({
      snapshot: vi.fn(async () => ({
        book: { bid_prices: [1], ask_prices: [1.1] },
        orderDetails: [
          {
            order_id: encodedOrderId(true, 500_000n),
            client_order_id: clientId.numeric,
            quantity: "500000000",
            filled_quantity: "100000000",
          },
        ],
      })),
    });
    const result = await runOwnerOrder({}, ["--list"], deps);
    expect(result.orders).toEqual([
      expect.objectContaining({
        clientOrderId: clientId.label,
        side: "BUY",
        price: 0.5,
        quantity: 0.4,
      }),
    ]);
    expect(deps.output).toHaveBeenCalledWith({
      mode: "LIST",
      orders: result.orders,
    });
  });
});
