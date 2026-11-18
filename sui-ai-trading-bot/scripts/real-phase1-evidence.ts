import { readFileSync } from "node:fs";
import { realConfigFromEnv } from "../apps/worker/src/real/config.ts";
import { RealTradeCapDatabase } from "../apps/worker/src/real/database.ts";
import { IndexerGraphqlHistorySource } from "../apps/worker/src/real/history-source.ts";
import type { RealHistoryEvent, RealIdentity } from "../apps/worker/src/real/types.ts";
import { isMainModule } from "./is-main-module.ts";

export const evidenceKeys = [
  "balanceManagerCreated", "tradeCapIssued", "depositSui", "depositDbusdc", "depositDeep",
  "orderPlaced", "orderFilled", "orderCancelled", "stopResumeS1", "stopResumeS2",
  "stopResumeS3", "stopResumeS4", "killSwitchRevoked", "killSwitchCancelled", "killSwitchWithdrawn",
] as const;
export type EvidenceKey = (typeof evidenceKeys)[number];
export type EvidenceManifest = Partial<Record<EvidenceKey, string[]>>;

const kinds: Partial<Record<EvidenceKey, RealHistoryEvent["kind"]>> = {
  orderPlaced: "ORDER_PLACED", orderFilled: "ORDER_FILLED", orderCancelled: "ORDER_CANCELLED",
};

export function phase1Checklist(events: RealHistoryEvent[], manifest: EvidenceManifest) {
  const chainDigests = new Set(events.map((event) => event.digest));
  const present = (key: EvidenceKey) => {
    if (kinds[key] && events.some((event) => event.kind === kinds[key])) return true;
    const digests = manifest[key] ?? [];
    return digests.length > 0 && digests.every((digest) => chainDigests.has(digest));
  };
  return evidenceKeys.map((key) => ({ key, status: present(key) ? "あり" as const : "なし" as const, digests: manifest[key] ?? [] }));
}

async function readAll(source: IndexerGraphqlHistorySource) {
  const events: RealHistoryEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await source.page(cursor);
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const { path, config } = realConfigFromEnv(process.env);
  const identity: RealIdentity = {
    network: config.network, balanceManagerId: config.balanceManagerId, poolKey: config.poolKey,
    tradeCapId: config.tradeCapId, signerAddress: config.signerAddress, sessionId: config.sessionId,
  };
  const db = new RealTradeCapDatabase(path);
  const local = db.ledgerEvents(identity);
  db.close();
  const chain = await readAll(new IndexerGraphqlHistorySource(config.indexerUrl, config.graphqlUrl, identity));
  const evidencePath = process.env.REAL_PHASE1_EVIDENCE_PATH ?? "data/real-phase1-evidence.json";
  const manifest = JSON.parse(readFileSync(evidencePath, "utf8")) as EvidenceManifest;
  console.info(JSON.stringify({ network: "testnet", checklist: phase1Checklist([...local, ...chain], manifest) }, null, 2));
}
