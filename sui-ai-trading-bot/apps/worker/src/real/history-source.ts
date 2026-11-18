import type {
  HistoryPage,
  RealHistoryEvent,
  RealHistorySource,
  RealIdentity,
} from "./types.ts";

interface GraphNode {
  digest: string;
  effects?: {
    checkpoint?: { sequenceNumber?: string; digest?: string };
    gasEffects?: { gasSummary?: { netGasUsage?: string } };
  };
}
interface HistoryResponse {
  data?: {
    transactionBlocks?: {
      nodes?: GraphNode[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
}
interface SubmissionResponse {
  data?: {
    transactionBlock?: {
      effects?: { status?: string | { success?: boolean; error?: unknown } };
    } | null;
  };
}
interface IndexedOrder {
  order_id: string;
  current_status: "Placed" | "Canceled" | "Filled";
  last_updated_at: number;
  original_quantity: number;
  remaining_quantity: number;
}

const post = async (url: string, body: unknown) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Error(`REAL_HISTORY_HTTP_${response.status}`);
  return response.json() as Promise<HistoryResponse>;
};
const get = async <T>(url: string) => {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw Error(`REAL_HISTORY_HTTP_${response.status}`);
  return response.json() as Promise<T>;
};

/** History transport deliberately accepts only normalized, paginated records.
 * The endpoint adapters are read-only and preserve checkpoint/event cursors. */
export class IndexerGraphqlHistorySource implements RealHistorySource {
  private lastCheckpoint: string;
  private lastCheckpointHash: string;
  constructor(
    private readonly indexerUrl: string,
    private readonly graphqlUrl: string,
    private readonly identity: RealIdentity,
    initial?: { checkpoint: string; checkpointHash: string },
  ) {
    this.lastCheckpoint = initial?.checkpoint ?? "0";
    this.lastCheckpointHash = initial?.checkpointHash ?? "GENESIS";
  }

  async page(cursor: string | null): Promise<HistoryPage> {
    const orderUrl = new URL(
      `/orders/${this.identity.poolKey}/${this.identity.balanceManagerId}`,
      this.indexerUrl,
    );
    orderUrl.searchParams.set("limit", "10000");
    orderUrl.searchParams.set("status", "Placed,Canceled,Filled");
    const [indexedOrders, graphql] = await Promise.all([
      get<IndexedOrder[]>(orderUrl.toString()),
      post(this.graphqlUrl, {
        query: `query TradeCapEffects($after: String, $address: SuiAddress!) {
        transactionBlocks(after: $after, filter: { affectedAddress: $address }) {
          pageInfo { hasNextPage endCursor } nodes { digest effects { status timestamp checkpoint { sequenceNumber digest } } }
        } }`,
        variables: { after: cursor, address: this.identity.balanceManagerId },
      }),
    ]);
    const effects = graphql.data?.transactionBlocks?.nodes ?? [];
    const normalized: RealHistoryEvent[] = [
      ...indexedOrders.map((order) => ({
        chain: "sui:testnet" as const,
        checkpoint: "0",
        digest: `indexer-order:${order.order_id}`,
        eventSequence: `${order.current_status}:${order.last_updated_at}`,
        kind:
          order.current_status === "Placed"
            ? ("ORDER_PLACED" as const)
            : order.current_status === "Canceled"
              ? ("ORDER_CANCELLED" as const)
              : ("ORDER_FILLED" as const),
        identity: this.identity,
        onchainOrderId: order.order_id,
        quantityAtomic: String(order.original_quantity),
        remainingAtomic: String(order.remaining_quantity),
        raw: order,
      })),
      ...effects.map((node) => ({
        chain: "sui:testnet" as const,
        checkpoint: String(node.effects?.checkpoint?.sequenceNumber ?? "0"),
        digest: node.digest,
        eventSequence: "effects:0",
        kind: "TX_EFFECTS" as const,
        identity: this.identity,
        asset: "SUI" as const,
        gasMist: String(
          node.effects?.gasEffects?.gasSummary?.netGasUsage ?? "0",
        ),
        raw: node,
      })),
    ];
    const pageInfo = graphql.data?.transactionBlocks?.pageInfo;
    const nextCursor = pageInfo?.hasNextPage
      ? (pageInfo.endCursor ?? null)
      : null;
    const finalCheckpoint = effects.at(-1)?.effects?.checkpoint;
    if (finalCheckpoint?.sequenceNumber !== undefined)
      this.lastCheckpoint = String(finalCheckpoint.sequenceNumber);
    if (finalCheckpoint?.digest)
      this.lastCheckpointHash = finalCheckpoint.digest;
    const checkpoint = this.lastCheckpoint;
    const checkpointHash = this.lastCheckpointHash;
    return { events: normalized, nextCursor, checkpoint, checkpointHash };
  }

  async submissionStatus(digest: string) {
    const response = (await post(this.graphqlUrl, {
      query: `query Submission($digest: String!) { transactionBlock(digest: $digest) { effects { status } } }`,
      variables: { digest },
    })) as SubmissionResponse;
    const raw = response.data?.transactionBlock?.effects?.status;
    if (typeof raw === "object" && raw !== null && raw.success === true)
      return "SUCCEEDED" as const;
    if (typeof raw === "object" && raw !== null && raw.success === false)
      return "FAILED" as const;
    const status = typeof raw === "string" ? raw.toUpperCase() : undefined;
    return status === "SUCCESS" || status === "SUCCEEDED"
      ? ("SUCCEEDED" as const)
      : status === "FAILURE" || status === "FAILED"
        ? ("FAILED" as const)
        : null;
  }
}
