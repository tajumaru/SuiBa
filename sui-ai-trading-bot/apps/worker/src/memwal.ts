import { MemWal } from "@mysten-incubation/memwal";
import type { BotDatabase } from "../../../packages/database/src/index.ts";
import {
  refreshSituationMemory,
  SITUATION_MEMORY_BIAS_PCT,
  SITUATION_MEMORY_MIN_SAMPLES,
  type SituationMemory,
} from "./situation-memory.ts";

export interface MemwalClient {
  remember(text: string, idempotencyKey: string): Promise<{ id: string }>;
  recall?(query: string): Promise<string | null>;
}

export interface MemwalConfig {
  privateKey: string;
  accountId: string;
  serverUrl: string;
  namespace: string;
}

export function memwalConfig(
  env: NodeJS.ProcessEnv = process.env,
): MemwalConfig | null {
  if (env.SUIBA_MEMWAL_ENABLED !== "true") return null;
  const privateKey = env.MEMWAL_PRIVATE_KEY,
    accountId = env.MEMWAL_ACCOUNT_ID,
    serverUrl = env.MEMWAL_RELAYER_URL,
    namespace = env.MEMWAL_NAMESPACE;
  return privateKey && accountId && serverUrl && namespace
    ? { privateKey, accountId, serverUrl, namespace }
    : null;
}

export function createMemwalClient(config: MemwalConfig): MemwalClient {
  const client = MemWal.create({
    key: config.privateKey,
    accountId: config.accountId,
    serverUrl: config.serverUrl,
    namespace: config.namespace,
  });
  return {
    async remember(text, idempotencyKey) {
      const job = await client.remember(text, { idempotencyKey });
      return { id: job.job_id };
    },
    async recall(query) {
      const result = await client.recall({ query, limit: 1 });
      const text = result.results[0]?.text;
      return typeof text === "string" && text.trim()
        ? text.trim().slice(0, 180)
        : null;
    },
  };
}

export class MemwalFlusher {
  private busy = false;
  constructor(
    private db: Pick<
      BotDatabase,
      "memwalPending" | "memwalSent" | "memwalFailed"
    >,
    private client: MemwalClient | null,
  ) {}
  async flush(now = Date.now()) {
    if (!this.client || this.busy) return;
    this.busy = true;
    try {
      for (const row of this.db.memwalPending(now)) {
        try {
          const job = await this.client.remember(row.text, row.id);
          this.db.memwalSent(row.id, job.id, now);
        } catch {
          try {
            this.db.memwalFailed(row.id);
          } catch {
            /* A pair switch may close this database while the job is in flight. */
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

export function startMemwalFlusher(
  db: BotDatabase,
  env: NodeJS.ProcessEnv = process.env,
  onMemorySaved: () => void = () => {},
) {
  const config = memwalConfig(env);
  const client = config ? createMemwalClient(config) : null;
  const flusher = new MemwalFlusher(db, client);
  let recallFor = "";
  const run = async () => {
    try {
      enqueueSettledShadowEpisodes(db);
      const statistic = refreshSituationMemory(db);
      if (statistic) onMemorySaved();
      void flusher.flush().catch(() => {});
      if (
        client?.recall &&
        statistic &&
        statistic.scene === "decision" &&
        statistic.n >= SITUATION_MEMORY_MIN_SAMPLES &&
        Math.abs(statistic.mean4hPct) >= SITUATION_MEMORY_BIAS_PCT &&
        recallFor !== `${statistic.key}:${statistic.evaluatedAt}`
      ) {
        recallFor = `${statistic.key}:${statistic.evaluatedAt}`;
        void attachRecall(db, client, statistic).then(onMemorySaved);
      }
    } catch {
      /* Mirror curation and delivery never affect the worker. */
    }
  };
  const timer = setInterval(run, 60_000);
  timer.unref();
  setImmediate(run);
  return { flusher, stop: () => clearInterval(timer) };
}

async function attachRecall(
  db: BotDatabase,
  client: MemwalClient,
  statistic: SituationMemory,
) {
  if (statistic.scene !== "decision") return;
  try {
    const recall = await client.recall?.(
      `${statistic.regime} ${statistic.kind} +4h`,
    );
    const current = db.get<SituationMemory>("situation_memory");
    if (
      recall &&
      current?.scene === "decision" &&
      current?.key === statistic.key &&
      current.evaluatedAt === statistic.evaluatedAt
    )
      db.set("situation_memory", { ...current, recall });
  } catch {
    /* Recall is optional display enrichment; the SQLite statistic remains. */
  }
}

type ShadowRecord = {
  cycleId: string;
  pair: string;
  candleTimestamp: number;
  action?: "BUY" | "WAIT";
  confidence?: number;
  ruleAction: string;
  selectedRule: string;
  status: string;
  snapshot?: { candle?: { close?: number } };
};

/** Curates only completed +4h comparisons; snapshots and model prose never leave SQLite. */
export function enqueueSettledShadowEpisodes(
  db: BotDatabase,
  now = Date.now(),
) {
  const candles = db.candles(300);
  if (!candles.length) return;
  const byTimestamp = new Map(candles.map((c) => [c.timestamp, c.close]));
  for (const record of db.history<ShadowRecord>("shadow_decisions", 500)) {
    const price = record.snapshot?.candle?.close;
    if (
      record.status !== "OK" ||
      !record.action ||
      typeof record.confidence !== "number" ||
      typeof price !== "number"
    )
      continue;
    const result = byTimestamp.get(record.candleTimestamp + 4 * 3600);
    if (result === undefined || price <= 0) continue;
    db.transaction(() =>
      db.enqueueMemwal(
        "shadow",
        shadowEpisode({
          at: record.candleTimestamp * 1000,
          pair: record.pair,
          action: record.action!,
          price,
          confidence: record.confidence!,
          ruleAction: record.ruleAction,
          selectedRule: record.selectedRule,
          return4hPct: (result / price - 1) * 100,
        }),
        record.cycleId,
        now,
      ),
    );
  }
}

const iso = (at: number) => new Date(at).toISOString();
const num = (value: number, digits: number) => value.toFixed(digits);

export function shadowEpisode(input: {
  at: number;
  pair: string;
  action: "BUY" | "WAIT";
  price: number;
  confidence: number;
  ruleAction: string;
  selectedRule: string;
  return4hPct: number;
}) {
  return `[shadow] ${iso(input.at)} ${input.pair}: AI=${input.action} (confidence ${num(input.confidence * 100, 0)}%), price=$${num(input.price, 4)}; rule=${input.ruleAction}/${input.selectedRule}; +4h=${num(input.return4hPct, 2)}%.`;
}

export function dailyReviewEpisode(input: { at: number; lesson: string }) {
  return `[daily-review] ${iso(input.at)} lesson: ${input.lesson}`;
}

export function narrationEpisode(input: {
  at: number;
  kind: "watchHit" | "nearMiss" | "review";
  pair: string;
}) {
  const curated = {
    watchHit: "注目条件が成立した。",
    nearMiss: "注目条件は成立せず、ニアミスで終了した。",
    review: "実況のふりかえりが生成された。",
  }[input.kind];
  return `[narration/${input.kind}] ${iso(input.at)} ${input.pair}: ${curated}`;
}
