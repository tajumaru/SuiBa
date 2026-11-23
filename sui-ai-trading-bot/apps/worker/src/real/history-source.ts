import { atomic, PHASE1_DECIMALS } from "./balance-evidence.ts";
import type {
  HistoryPage,
  RealHistoryEvent,
  RealHistorySource,
  RealIdentity,
} from "./types.ts";

interface GraphNode {
  digest: string;
  effects?: {
    timestamp?: string | null;
    checkpoint?: { sequenceNumber?: string; digest?: string };
    gasEffects?: {
      gasSummary?: {
        computationCost?: string;
        storageCost?: string;
        storageRebate?: string;
      };
    };
  };
}
interface HistoryResponse {
  data?: {
    transactions?: {
      nodes?: GraphNode[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
}
interface SubmissionResponse {
  data?: {
    transaction?: {
      effects?: { status?: string | { success?: boolean; error?: unknown } };
    } | null;
  };
}
interface GraphqlEnvelope {
  data?: unknown;
  errors?: unknown[];
}
interface IndexedOrder {
  order_id: string;
  current_status: "Placed" | "Canceled" | "Filled";
  last_updated_at: number;
  original_quantity: number;
  remaining_quantity: number;
}

interface IndexedTrade {
  trade_id: string;
  timestamp: number;
  digest: string;
  taker_client_order_id: string;
  taker_balance_manager_id: string;
  taker_is_bid: boolean;
  base_volume: number | string;
  quote_volume: number | string;
  taker_fee: number | string;
  taker_fee_is_deep: boolean;
}

const HISTORY_TRADE_LIMIT = 10_000;

function tradeAtomic(value: string | number, decimals: number) {
  const text = String(value);
  // JSON numbers below 1e-6 are stringified in exponential notation.
  const scientific = /^(\d)(?:\.(\d+))?e-([1-9]\d?)$/.exec(text);
  if (!scientific) return atomic(text, decimals);
  const [, whole, fraction = "", exponent] = scientific;
  if (Number(exponent) > decimals)
    throw Error("REAL_BALANCE_PRECISION_INVALID");
  return atomic(
    `0.${"0".repeat(Number(exponent) - 1)}${whole}${fraction}`,
    decimals,
  );
}

function tradeEvents(
  trade: IndexedTrade,
  identity: RealIdentity,
): RealHistoryEvent[] {
  if (
    trade.taker_balance_manager_id !== identity.balanceManagerId ||
    !trade.trade_id ||
    !trade.digest ||
    typeof trade.taker_is_bid !== "boolean" ||
    typeof trade.taker_client_order_id !== "string" ||
    !/^\d+$/.test(trade.taker_client_order_id) ||
    trade.taker_fee_is_deep !== true
  )
    throw Error("REAL_HISTORY_TRADE_INVALID");
  const direction = trade.taker_is_bid ? 1n : -1n;
  const base = tradeAtomic(trade.base_volume, PHASE1_DECIMALS.SUI);
  const quote = tradeAtomic(trade.quote_volume, PHASE1_DECIMALS.DBUSDC);
  const fee = tradeAtomic(trade.taker_fee, PHASE1_DECIMALS.DEEP);
  const common = {
    chain: "sui:testnet" as const,
    checkpoint: "0",
    digest: trade.digest,
    timestampMs: trade.timestamp,
    identity,
    clientOrderId: trade.taker_client_order_id,
    raw: trade,
  };
  return [
    {
      ...common,
      kind: "TRADE_FILL",
      asset: "SUI",
      eventSequence: `trade:${trade.trade_id}:SUI`,
      availableAtomicDelta: String(direction * base),
    },
    {
      ...common,
      kind: "TRADE_FILL",
      asset: "DBUSDC",
      eventSequence: `trade:${trade.trade_id}:DBUSDC`,
      availableAtomicDelta: String(-direction * quote),
    },
    {
      ...common,
      kind: "TRADE_FEE",
      asset: "DEEP",
      eventSequence: `trade-fee:${trade.trade_id}`,
      availableAtomicDelta: String(-fee),
      feeAtomic: String(fee),
    },
  ];
}

const post = async (url: string, body: unknown) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Error(`REAL_HISTORY_HTTP_${response.status}`);
  const payload = (await response.json()) as GraphqlEnvelope;
  if (payload.errors?.length) throw Error("REAL_HISTORY_GRAPHQL_ERRORS");
  if (!payload.data) throw Error("REAL_HISTORY_GRAPHQL_DATA_MISSING");
  return payload as HistoryResponse;
};
const get = async <T>(url: string) => {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw Error(`REAL_HISTORY_HTTP_${response.status}`);
  return response.json() as Promise<T>;
};

export const HISTORY_QUERY = `query TradeCapEffects($after: String, $address: SuiAddress!) {
  transactions(after: $after, filter: { affectedObject: $address }) {
    pageInfo { hasNextPage endCursor }
    nodes { digest effects { status timestamp checkpoint { sequenceNumber digest } gasEffects {
      gasSummary { computationCost storageCost storageRebate }
    } } }
  }
}`;

export const SUBMISSION_QUERY = `query Submission($digest: String!) {
  transaction(digest: $digest) { effects { status } }
}`;

export function netGasUsage(
  summary:
    | {
        computationCost?: string;
        storageCost?: string;
        storageRebate?: string;
      }
    | undefined,
): string {
  if (!summary) throw Error("REAL_HISTORY_GAS_SUMMARY_MISSING");
  return (
    BigInt(summary.computationCost ?? "0") +
    BigInt(summary.storageCost ?? "0") -
    BigInt(summary.storageRebate ?? "0")
  ).toString();
}

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
    const tradeUrl = new URL(
      `/trades/${this.identity.poolKey}`,
      this.indexerUrl,
    );
    tradeUrl.searchParams.set(
      "taker_balance_manager_id",
      this.identity.balanceManagerId,
    );
    tradeUrl.searchParams.set("start_time", "1");
    tradeUrl.searchParams.set("limit", String(HISTORY_TRADE_LIMIT));
    const [indexedOrders, indexedTrades, graphql] = await Promise.all([
      get<IndexedOrder[]>(orderUrl.toString()),
      get<IndexedTrade[]>(tradeUrl.toString()),
      post(this.graphqlUrl, {
        query: HISTORY_QUERY,
        variables: { after: cursor, address: this.identity.balanceManagerId },
      }),
    ]);
    const connection = graphql.data?.transactions;
    if (!connection) throw Error("REAL_HISTORY_TRANSACTIONS_MISSING");
    if (
      !Array.isArray(indexedTrades) ||
      indexedTrades.length >= HISTORY_TRADE_LIMIT
    )
      throw Error("REAL_HISTORY_TRADES_INCOMPLETE");
    const effects = connection.nodes ?? [];
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
      ...indexedTrades.flatMap((trade) => tradeEvents(trade, this.identity)),
      ...effects.map((node): RealHistoryEvent => {
        const timestampMs = Date.parse(node.effects?.timestamp ?? "");
        return {
          chain: "sui:testnet" as const,
          checkpoint: String(node.effects?.checkpoint?.sequenceNumber ?? "0"),
          digest: node.digest,
          eventSequence: "effects:history",
          kind: "TX_EFFECTS" as const,
          identity: this.identity,
          asset: "SUI" as const,
          gasMist: String(netGasUsage(node.effects?.gasEffects?.gasSummary)),
          timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
          raw: node,
        };
      }),
    ];
    const pageInfo = connection.pageInfo;
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
      query: SUBMISSION_QUERY,
      variables: { digest },
    })) as SubmissionResponse;
    const raw = response.data?.transaction?.effects?.status;
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
