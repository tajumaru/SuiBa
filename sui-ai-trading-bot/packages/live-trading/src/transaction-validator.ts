import { Transaction } from "@mysten/sui/transactions";
import { isDeepStrictEqual } from "node:util";
import { expectedTransaction } from "./transaction-builder.ts";
import {
  hashBytes,
  requireLive,
  validateIntent,
  validateRoute,
} from "./policy.ts";
import type { BuildContext, BuiltTransaction, LiveRequest } from "./types.ts";
export class TransactionValidator {
  async validate(
    b: BuiltTransaction,
    c: BuildContext,
    request: LiveRequest,
    now: number,
  ) {
    validateIntent(request, c.wallet, c.policy, now);
    validateRoute(c.route, c.policy);
    requireLive(
      isDeepStrictEqual(b.quote, request.quote) &&
        isDeepStrictEqual(c.route.quote, request.quote),
      "QUOTE_CHANGED",
    );
    requireLive(hashBytes(b.bytes) === b.hash, "TRANSACTION_CHANGED");
    // Decode the final BCS bytes, not a preview JSON or a list of claimed calls. Reject extra commands,
    // unexpected input refs, pure values, type arguments, recipients, gas owner/payment/budget and intents.
    const decoded = Transaction.from(b.bytes).getData();
    const expected = expectedTransaction(c);
    const expectedBytes = await expected.build();
    const expectedData = Transaction.from(expectedBytes).getData();
    requireLive(
      isDeepStrictEqual(decoded, expectedData),
      "PTB_NOT_ALLOWLISTED",
    );
    const slippagePpm = Math.round(request.quote.slippage * 1e6);
    requireLive(
      Math.abs(slippagePpm / 1e6 - request.quote.slippage) < 1e-12,
      "UNSUPPORTED_SLIPPAGE_PRECISION",
    );
    return { hash: b.hash, minimumProtected: true as const };
  }
}
