import type { RealIdentity } from "./types.ts";

interface TradeCapResponse {
  data?: {
    object?: {
      owner?: {
        __typename?: string;
        address?: { address?: string };
      };
      asMoveObject?: {
        contents?: { type?: { repr?: string }; json?: unknown };
      };
    } | null;
  };
  errors?: unknown[];
}

export interface TradeCapEvidence {
  valid: boolean;
  queryErrored: boolean;
  conjuncts: {
    exists: boolean;
    addressOwnedByBot: boolean;
    tradeCapType: boolean;
    balanceManagerMatches: boolean;
  };
}

export const TRADE_CAP_QUERY = `query TradeCap($address: SuiAddress!) {
  object(address: $address) {
    owner { __typename ... on AddressOwner { address { address } } }
    asMoveObject { contents { type { repr } json } }
  }
}`;

const sameAddress = (left: unknown, right: string) =>
  typeof left === "string" && left.toLowerCase() === right.toLowerCase();

/** Proves the configured TradeCap still exists, is address-owned by the bot,
 * and is bound to the configured BalanceManager. Any uncertainty fails closed. */
export async function tradeCapValid(
  graphqlUrl: string,
  identity: RealIdentity,
  request: typeof fetch = fetch,
) {
  return (await tradeCapEvidence(graphqlUrl, identity, request)).valid;
}

export async function tradeCapEvidence(
  graphqlUrl: string,
  identity: RealIdentity,
  request: typeof fetch = fetch,
): Promise<TradeCapEvidence> {
  const failed = (queryErrored: boolean): TradeCapEvidence => ({
    valid: false,
    queryErrored,
    conjuncts: {
      exists: false,
      addressOwnedByBot: false,
      tradeCapType: false,
      balanceManagerMatches: false,
    },
  });
  try {
    const response = await request(graphqlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: TRADE_CAP_QUERY,
        variables: { address: identity.tradeCapId },
      }),
    });
    if (!response.ok) return failed(true);
    const result = (await response.json()) as TradeCapResponse;
    if (result.errors?.length || !result.data) return failed(true);
    const object = result.data?.object;
    const json = object?.asMoveObject?.contents?.json;
    const fields =
      json && typeof json === "object" && !Array.isArray(json)
        ? (json as Record<string, unknown>)
        : {};
    const conjuncts = {
      exists: object !== null && object !== undefined,
      addressOwnedByBot:
        object?.owner?.__typename === "AddressOwner" &&
        sameAddress(object.owner.address?.address, identity.signerAddress),
      tradeCapType:
        object?.asMoveObject?.contents?.type?.repr?.endsWith(
          "::balance_manager::TradeCap",
        ) === true,
      balanceManagerMatches: sameAddress(
        fields.balance_manager_id,
        identity.balanceManagerId,
      ),
    };
    return {
      valid: Object.values(conjuncts).every(Boolean),
      queryErrored: false,
      conjuncts,
    };
  } catch {
    return failed(true);
  }
}
