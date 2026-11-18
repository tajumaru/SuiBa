import type { RealIdentity } from "./types.ts";

interface TradeCapResponse {
  data?: {
    object?: {
      owner?: {
        __typename?: string;
        address?: { address?: string };
      };
      contents?: {
        type?: { repr?: string };
        json?: unknown;
      };
    } | null;
  };
  errors?: unknown[];
}

const sameAddress = (left: unknown, right: string) =>
  typeof left === "string" && left.toLowerCase() === right.toLowerCase();

/** Proves the configured TradeCap still exists, is address-owned by the bot,
 * and is bound to the configured BalanceManager. Any uncertainty fails closed. */
export async function tradeCapValid(
  graphqlUrl: string,
  identity: RealIdentity,
  request: typeof fetch = fetch,
) {
  try {
    const response = await request(graphqlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `query TradeCap($address: SuiAddress!) {
          object(address: $address) {
            owner { __typename ... on AddressOwner { address { address } } }
            contents { type { repr } json }
          }
        }`,
        variables: { address: identity.tradeCapId },
      }),
    });
    if (!response.ok) return false;
    const result = (await response.json()) as TradeCapResponse;
    if (result.errors?.length) return false;
    const object = result.data?.object;
    const json = object?.contents?.json;
    if (!object || !json || typeof json !== "object" || Array.isArray(json))
      return false;
    const fields = json as Record<string, unknown>;
    return (
      object.owner?.__typename === "AddressOwner" &&
      sameAddress(object.owner.address?.address, identity.signerAddress) &&
      object.contents?.type?.repr?.endsWith("::balance_manager::TradeCap") ===
        true &&
      sameAddress(fields.balance_manager_id, identity.balanceManagerId)
    );
  } catch {
    return false;
  }
}
