import { Transaction } from "@mysten/sui/transactions";
import { coin, SUI, USDC, Decimal, bounded } from "../../shared/src/index.ts";
import { address, hashBytes, mainnet, requireLive, uint } from "./policy.ts";
import type {
  BuildContext,
  BuiltTransaction,
  LiveRequest,
  SimulationApi,
  SimulationReport,
} from "./types.ts";
export class TransactionSimulator {
  constructor(private client: SimulationApi) {}
  async simulate(
    b: BuiltTransaction,
    c: BuildContext,
    request: LiveRequest,
  ): Promise<SimulationReport> {
    const chain = await bounded(() => this.client.getChainIdentifier());
    requireLive(mainnet(chain.chainIdentifier), "NETWORK_MISMATCH");
    requireLive(hashBytes(b.bytes) === b.hash, "TRANSACTION_CHANGED");
    const result = await bounded(() =>
      this.client.simulateTransaction({
        transaction: new Uint8Array(b.bytes),
        checksEnabled: true,
        doGasSelection: false,
        include: { effects: true, balanceChanges: true, transaction: true },
      }),
    );
    requireLive(
      result.$kind === "Transaction" &&
        result.Transaction.status.success &&
        result.Transaction.effects?.status.success &&
        !result.gasPaymentMocked,
      "SIMULATION_FAILED",
    );
    const tx = result.Transaction;
    requireLive(
      tx.transaction &&
        hashBytes(
          await Transaction.from(JSON.stringify(tx.transaction)).build(),
        ) === b.hash,
      "SIMULATION_TRANSACTION_MISMATCH",
    );
    const effects = tx.effects!;
    const g = effects.gasUsed;
    const gas =
      uint(g.computationCost) + uint(g.storageCost) - uint(g.storageRebate);
    requireLive(
      gas >= 0n && gas <= uint(c.policy.gasBudgetMist),
      "GAS_ESTIMATE_INVALID",
    );
    const balances = new Map([
      [SUI, 0n],
      [USDC, 0n],
    ]);
    requireLive(Array.isArray(tx.balanceChanges), "MISSING_BALANCE_CHANGES");
    for (const change of tx.balanceChanges) {
      requireLive(
        address(change.address) === address(c.policy.allowedWallet),
        "UNEXPECTED_RECIPIENT",
      );
      const type = coin(change.coinType);
      requireLive(/^-?\d+$/.test(change.amount), "INVALID_BALANCE_DELTA");
      balances.set(type, balances.get(type)! + BigInt(change.amount));
    }
    const q = request.quote,
      input = coin(q.from),
      output = coin(q.to);
    const spent = -balances.get(input)! - (input === SUI ? gas : 0n),
      received = balances.get(output)! + (output === SUI ? gas : 0n);
    requireLive(
      spent === uint(q.amountIn) && received >= uint(q.minAmountOut),
      "BALANCE_MISMATCH",
    );
    const newSui = uint(c.wallet.sui) + balances.get(SUI)!,
      newUsdc = uint(c.wallet.usdc) + balances.get(USDC)!;
    requireLive(
      newSui >= uint(c.policy.minGasReserveMist) && newUsdc >= 0n,
      "INSUFFICIENT_GAS",
    );
    if (input === USDC) {
      const suiValue = new Decimal(newSui.toString())
          .div(1e9)
          .mul(q.referencePrice),
        total = suiValue.plus(new Decimal(newUsdc.toString()).div(1e6));
      requireLive(
        total.gt(0) &&
          suiValue.div(total).lte(request.risk.settings.maxHoldingRatio),
        "POST_SIMULATION_HOLDING_LIMIT",
      );
    }
    requireLive(Date.now() < q.expiresAt, "QUOTE_EXPIRED");
    return {
      transactionHash: b.hash,
      simulatedAt: Date.now(),
      gasMist: gas.toString(),
      receivedAtomic: received.toString(),
      inputAtomic: spent.toString(),
      status: "SIMULATED_ONLY",
    };
  }
}
