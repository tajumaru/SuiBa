import { GrpcWebFetchTransport, SuiGrpcClient } from "@mysten/sui/grpc";
import type { ChainInfo } from "../../../packages/shared/src/index.ts";

export interface RawChainSample {
  epoch: number;
  checkpoint: number;
  totalNetworkTransactions: number;
  /** Reference gas price in MIST, or null when that read alone
   * failed (the rest of the sample still counts). */
  gasMist: number | null;
}

/**
 * Builds a fetcher for raw chain samples over a DEDICATED raw
 * gRPC client. This must never go through ReadOnlySuiClient:
 * every call there flows through the shared apiAccess layer
 * (backoff, circuit breaker, transient-failure hooks) and the
 * validation observation machinery, so a display poll could
 * keep the Sui API in backoff, block pair switching, or pause
 * the bot. Here a failure is just null — the displayed numbers
 * freeze, and nothing else in the process can tell it happened.
 */
export function createChainInfoFetcher(
  url = "https://fullnode.mainnet.sui.io:443",
): () => Promise<RawChainSample | null> {
  if (new URL(url).protocol !== "https:") throw new Error("HTTPS_REQUIRED");
  // The gRPC-Web fetch transport, as the trading client uses:
  // the SDK's default transport does not speak to the public
  // fullnode from a fetch environment.
  const client = new SuiGrpcClient({
    network: "mainnet",
    transport: new GrpcWebFetchTransport({ baseUrl: url }),
  });
  let inFlight = false;
  return async () => {
    if (inFlight) return null;
    inFlight = true;
    try {
      return await Promise.race([
        readChainSample(client),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), 10000),
        ),
      ]);
    } finally {
      inFlight = false;
    }
  };
}

async function readChainSample(
  client: SuiGrpcClient,
): Promise<RawChainSample | null> {
  try {
    const info = await client.ledgerService.getServiceInfo({}).response;
    const epoch = info.epoch,
      checkpoint = info.checkpointHeight;
    if (epoch == null || checkpoint == null) return null;
    const detail = await client.ledgerService.getCheckpoint({
      checkpointId: {
        oneofKind: "sequenceNumber",
        sequenceNumber: checkpoint,
      },
      readMask: { paths: ["summary"] },
    }).response;
    const total = detail.checkpoint?.summary?.totalNetworkTransactions;
    if (total == null) return null;
    let gasMist: number | null = null;
    try {
      const gas = await client.getReferenceGasPrice();
      const parsed = Number(gas.referenceGasPrice);
      if (Number.isSafeInteger(parsed) && parsed >= 0) gasMist = parsed;
    } catch {
      // Gas is garnish: a failed gas read never voids the sample.
    }
    const out: RawChainSample = {
      epoch: Number(epoch),
      checkpoint: Number(checkpoint),
      totalNetworkTransactions: Number(total),
      gasMist,
    };
    return Number.isSafeInteger(out.epoch) &&
      out.epoch >= 0 &&
      Number.isSafeInteger(out.checkpoint) &&
      out.checkpoint > 0 &&
      Number.isSafeInteger(out.totalNetworkTransactions) &&
      out.totalNetworkTransactions >= 0
      ? out
      : null;
  } catch {
    return null;
  }
}

/**
 * Turns raw chain samples (epoch / checkpoint / cumulative
 * network transactions) into the display ChainInfo, deriving
 * TPS from the samples inside a trailing window. Purely
 * presentational: samples arrive from a dedicated read client
 * on an interval, and nothing here feeds a trading or safety
 * decision. A missing or failed sample simply leaves the last
 * known values in place (their stillness is itself the signal).
 */
export class ChainSampler {
  private samples: { totalTx: number; at: number }[] = [];
  private latest: ChainInfo | null = null;
  observe(raw: RawChainSample, now = Date.now()): ChainInfo {
    this.samples = [
      ...this.samples.filter((s) => now - s.at <= 90000),
      { totalTx: raw.totalNetworkTransactions, at: now },
    ];
    let tps: number | null = null;
    const first = this.samples[0],
      last = this.samples.at(-1)!;
    if (
      this.samples.length > 1 &&
      last.at - first.at >= 20000 &&
      last.totalTx >= first.totalTx
    )
      tps = Math.round(((last.totalTx - first.totalTx) / (last.at - first.at)) * 1000);
    this.latest = {
      epoch: raw.epoch,
      checkpoint: raw.checkpoint,
      tps,
      // The gas price only moves at epoch boundaries; a sample
      // whose gas read failed keeps the last known price.
      gasMist: raw.gasMist ?? this.latest?.gasMist ?? null,
      at: now,
    };
    return this.latest;
  }
  current(): ChainInfo | null {
    return this.latest;
  }
}
