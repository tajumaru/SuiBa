import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BrowserSessions } from "../apps/worker/src/browser-session.ts";
import { createRequestHandler } from "../apps/worker/src/http-routes.ts";
import type { WorkerContext } from "../apps/worker/src/worker-context.ts";
import {
  BotDatabase,
  NARRATION_RETENTION_CHUNK_ROWS,
  NARRATION_RETENTION_DAYS,
  NARRATION_RETENTION_ROWS,
} from "../packages/database/src/index.ts";
import { withApiTiming } from "../packages/shared/src/api-timing.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { emptyNarrationState } from "../apps/dashboard/src/narration/state.ts";
import {
  NARRATION_STATE_VERSION,
  narrationIdentity,
  NarrationGenerator,
  SERVER_NARRATION_KINDS,
} from "../apps/worker/src/narration-generator.ts";

const day = 24 * 60 * 60 * 1000;
const now = 2_000_000_000_000;
const databases: BotDatabase[] = [];
const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
});

function entry(db: BotDatabase, index: number, occurredAt = now) {
  return db.appendNarrationEntry({
    id: `entry-${index}`,
    pair: "SUI_USDC",
    sourceKey: `source-${index}`,
    kind: "cycle",
    occurredAt,
    createdAt: occurredAt + 1,
    json: { text: `entry ${index}` },
  });
}

async function api(db: BotDatabase) {
  const admin = randomBytes(32).toString("hex");
  const readonly = randomBytes(32).toString("hex");
  const sessions = new BrowserSessions(admin, readonly);
  const ctx = {
    browserSessions: sessions,
    pair: "SUI_USDC",
    switching: false,
    db,
  } as unknown as WorkerContext;
  const handler = createRequestHandler(ctx);
  const server = createServer((req, res) => {
    void withApiTiming(() => handler(req, res));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    readonly,
    request: (query: string, token = readonly, method = "GET") =>
      fetch(`${origin}/api/narration?${query}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      }),
  };
}

describe("narration database migration", () => {
  it("creates both tables idempotently and supports state round trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "suiba-narration-"));
    tempDirs.push(dir);
    const path = join(dir, "bot.sqlite");
    new BotDatabase(path).close();
    const db = new BotDatabase(path);
    databases.push(db);
    db.setNarrationState({
      pair: "SUI_USDC",
      version: 1,
      updatedAt: now,
      json: { cursor: 7 },
    });
    expect(db.narrationState("SUI_USDC")).toEqual({
      pair: "SUI_USDC",
      version: 1,
      updatedAt: now,
      json: { cursor: 7 },
    });
    const inspect = new DatabaseSync(path);
    expect(
      inspect
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('narration_entries','narration_state') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "narration_entries" }, { name: "narration_state" }]);
    inspect.close();
  });

  it("commits entries and their cursor atomically and exposes kind counts", () => {
    const db = new BotDatabase(":memory:");
    databases.push(db);
    db.commitNarration([
      {
        id: "stable-1", pair: "SUI_USDC", sourceKey: "decision:1:0",
        kind: "cycle", occurredAt: now, createdAt: now + 1,
        json: { text: "recorded fact" },
      },
    ], {
      pair: "SUI_USDC", version: 1, updatedAt: now + 1,
      json: { cursor: "decision:1" },
    });
    expect(db.narrationCounts("SUI_USDC")).toEqual({ cycle: 1 });
    expect(db.narrationState("SUI_USDC")?.json).toEqual({ cursor: "decision:1" });
    // Replaying the material after a crash cannot add a duplicate row.
    db.commitNarration([
      {
        id: "stable-1", pair: "SUI_USDC", sourceKey: "decision:1:0",
        kind: "cycle", occurredAt: now, createdAt: now + 2,
        json: { text: "recorded fact" },
      },
    ], {
      pair: "SUI_USDC", version: 1, updatedAt: now + 2,
      json: { cursor: "decision:1" },
    });
    expect(db.narrationEntries("SUI_USDC").entries).toHaveLength(1);
  });

  it("queues a server narration mirror in the same commit only once", () => {
    const db = new BotDatabase(":memory:");
    databases.push(db);
    const row = {
      id: "watch-hit-1", pair: "SUI_USDC", sourceKey: "watch:1",
      kind: "watchHit", occurredAt: now, createdAt: now + 1,
      json: { text: "条件成立" },
    };
    const state = {
      pair: "SUI_USDC", version: 2, updatedAt: now + 1,
      json: { cursor: "watch:1" },
    };
    const mirror = {
      text: `[narration/watchHit] ${new Date(now).toISOString()} SUI_USDC: 注目条件が成立した。`,
      sourceId: "SUI_USDC:watch-hit-1",
      createdAt: now,
    };
    db.commitNarration([row], state, [mirror]);
    db.commitNarration([row], state, [mirror]);
    expect(db.memwalPending(now + 5000)).toEqual([
      expect.objectContaining({
        kind: "narration",
        text: mirror.text,
        sourceId: mirror.sourceId,
      }),
    ]);
  });
});

describe("server narration identity", () => {
  it("keeps the complete stage-1 set fixed and hashes facts independently of text", () => {
    expect(SERVER_NARRATION_KINDS).toHaveLength(28);
    expect(new Set(SERVER_NARRATION_KINDS).size).toBe(28);
    expect(SERVER_NARRATION_KINDS).toEqual(expect.arrayContaining([
      "nearMiss", "watchHit", "reach", "superReach", "priceLine",
      "priceLineReached", "sellLine", "sellLineCrossing", "review", "alert",
      "monthlyReport",
    ]));
    expect(narrationIdentity("SUI_USDC", "cycle", "decision:1", 0)).toBe(
      narrationIdentity("SUI_USDC", "cycle", "decision:1", 0),
    );
    expect(narrationIdentity("WAL_USDC", "cycle", "decision:1", 0)).not.toBe(
      narrationIdentity("SUI_USDC", "cycle", "decision:1", 0),
    );
    expect(narrationIdentity("SUI_USDC", "cycle", "decision:1", 1)).not.toBe(
      narrationIdentity("SUI_USDC", "cycle", "decision:1", 0),
    );
  });

  it("does no reads or writes while the feature flag is off", () => {
    vi.stubEnv("SUIBA_NARRATION_GENERATION_ENABLED", "false");
    const db = new BotDatabase(":memory:");
    databases.push(db);
    const generator = new NarrationGenerator(
      db,
      "SUI_USDC",
      null as never,
      () => now,
    );
    expect(generator.generate()).toBe(0);
    expect(db.narrationEntries("SUI_USDC").entries).toEqual([]);
    expect(db.narrationState("SUI_USDC")).toBeNull();
  });

  it("replays a committed operation with the terminal template exactly once", () => {
    vi.stubEnv("SUIBA_NARRATION_GENERATION_ENABLED", "true");
    const db = new BotDatabase(":memory:");
    databases.push(db);
    const monitor = new OperationMonitor(db);
    monitor.event("CONTROL", "MANUAL_START", now);
    const engine = {
      monitor,
      snapshot: () => ({
        runtime: db.runtime(),
        forecast: { records: [], events: [] },
        trades: [],
        btc: null,
        candlesByTimeframe: { 300: [] },
        bookLevels: null,
        settings: db.settings(),
        chain: null,
      }),
    };
    const generator = new NarrationGenerator(
      db, "SUI_USDC", engine as never, () => now + 1,
    );
    expect(generator.generate()).toBe(1);
    expect(db.narrationEntries("SUI_USDC").entries[0]).toMatchObject({
      kind: "start",
      occurredAt: now,
      json: { text: "PAPER運用を始めたよ" },
    });
    expect(generator.generate()).toBe(0);
    expect(db.narrationEntries("SUI_USDC").entries).toHaveLength(1);
  });

  it("migrates a valid stage-1a state to version 2 without resetting it", () => {
    vi.stubEnv("SUIBA_NARRATION_GENERATION_ENABLED", "true");
    const db = new BotDatabase(":memory:");
    databases.push(db);
    const narration = {
      ...emptyNarrationState(),
      initialized: true,
      hitStreak: 2,
      watchScore: { declared: 4, hits: 2, misses: 1, unreviewed: 1 },
    };
    db.setNarrationState({
      pair: "SUI_USDC", version: 1, updatedAt: now,
      json: { narration, lastEpoch: 9 },
    });
    const monitor = new OperationMonitor(db);
    const engine = {
      monitor,
      snapshot: () => ({
        runtime: db.runtime(), forecast: { records: [], events: [] }, trades: [],
        btc: null, candlesByTimeframe: { 300: [] }, bookLevels: null,
        settings: db.settings(), chain: { epoch: 9 },
      }),
    };
    const generator = new NarrationGenerator(db, "SUI_USDC", engine as never, () => now + 1);
    expect(generator.generate()).toBe(0);
    const saved = db.narrationState("SUI_USDC");
    expect(saved?.version).toBe(NARRATION_STATE_VERSION);
    expect((saved?.json as { narration: typeof narration }).narration).toMatchObject({
      hitStreak: 2,
      watchScore: { declared: 4, hits: 2, misses: 1, unreviewed: 1 },
    });
  });

  it("refuses unknown versions and malformed current state without advancing", () => {
    vi.stubEnv("SUIBA_NARRATION_GENERATION_ENABLED", "true");
    for (const state of [
      { version: 99, json: { narration: emptyNarrationState(), lastEpoch: null } },
      { version: NARRATION_STATE_VERSION, json: { narration: {}, lastEpoch: null } },
    ]) {
      const db = new BotDatabase(":memory:");
      databases.push(db);
      db.setNarrationState({ pair: "SUI_USDC", updatedAt: now, ...state });
      const generator = new NarrationGenerator(db, "SUI_USDC", null as never, () => now + 1);
      expect(() => generator.generate()).toThrow(
        state.version === 99 ? "NARRATION_STATE_VERSION_UNSUPPORTED" : "NARRATION_STATE_INVALID",
      );
      expect(db.narrationEntries("SUI_USDC").entries).toEqual([]);
      expect(db.narrationState("SUI_USDC")?.version).toBe(state.version);
    }
  });
});

describe("GET /api/narration", () => {
  it("returns an authenticated empty feed and rejects readonly mutations", async () => {
    const db = new BotDatabase(":memory:");
    databases.push(db);
    const client = await api(db);
    const response = await client.request("pair=SUI_USDC");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema: 1,
      pair: "SUI_USDC",
      entries: [],
      nextSince: null,
      hasMore: false,
      oldestAvailable: null,
    });
    expect(
      (await client.request("pair=SUI_USDC", client.readonly, "POST")).status,
    ).toBe(403);
    expect((await client.request("pair=SUI_USDC", "wrong")).status).toBe(401);
  });

  it("returns the latest 30 ascending and pages with an exclusive cursor", async () => {
    const db = new BotDatabase(":memory:");
    databases.push(db);
    for (let i = 1; i <= 35; i++) entry(db, i);
    const client = await api(db);
    const latest = await (await client.request("pair=SUI_USDC")).json();
    expect(latest.entries).toHaveLength(30);
    expect(latest.entries[0].seq).toBe(6);
    expect(latest.nextSince).toBe(35);
    const first = await (
      await client.request("pair=SUI_USDC&since=5&limit=10")
    ).json();
    expect(first.entries.map((item: { seq: number }) => item.seq)).toEqual([
      6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(first).toMatchObject({
      nextSince: 15,
      hasMore: true,
      oldestAvailable: 1,
    });
    const rest = await (
      await client.request("pair=SUI_USDC&since=15&limit=200")
    ).json();
    expect(rest.entries[0].seq).toBe(16);
    expect(rest).toMatchObject({ nextSince: 35, hasMore: false });
  });

  it("reports expired cursors and validates pair and cursor inputs", async () => {
    const db = new BotDatabase(":memory:");
    databases.push(db);
    for (let i = 1; i <= 4; i++) entry(db, i, now - 31 * day);
    expect(db.maintainNarrationRetentionChunk("SUI_USDC", now)).toBe(4);
    entry(db, 5, now);
    const client = await api(db);
    const expired = await client.request("pair=SUI_USDC&since=2");
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({
      error: "NARRATION_CURSOR_EXPIRED",
      oldestAvailable: 5,
    });
    expect((await client.request("pair=WAL_USDC")).status).toBe(409);
    expect((await client.request("pair=BTC_USDC")).status).toBe(400);
    expect((await client.request("pair=SUI_USDC&since=-1")).status).toBe(400);
    expect((await client.request("pair=SUI_USDC&limit=201")).status).toBe(400);
  });
});

describe("narration retention", () => {
  it("deletes age-expired rows only before the 30-day boundary", () => {
    const db = new BotDatabase(":memory:");
    databases.push(db);
    entry(db, 1, now - NARRATION_RETENTION_DAYS * day - 1);
    entry(db, 2, now - NARRATION_RETENTION_DAYS * day);
    expect(db.maintainNarrationRetentionChunk("SUI_USDC", now)).toBe(1);
    expect(
      db.narrationEntries("SUI_USDC").entries.map((item) => item.id),
    ).toEqual(["entry-2"]);
  });

  it("keeps 50,000 newest rows and deletes at most 200 per pass", () => {
    const db = new BotDatabase(":memory:");
    databases.push(db);
    const extra = NARRATION_RETENTION_CHUNK_ROWS + 3;
    for (let i = 0; i < NARRATION_RETENTION_ROWS + extra; i++) entry(db, i);
    expect(db.maintainNarrationRetentionChunk("SUI_USDC", now)).toBe(
      NARRATION_RETENTION_CHUNK_ROWS,
    );
    expect(db.maintainNarrationRetentionChunk("SUI_USDC", now)).toBe(3);
    expect(db.maintainNarrationRetentionChunk("SUI_USDC", now)).toBe(0);
    expect(db.narrationEntries("SUI_USDC", 203, 200).oldestAvailable).toBe(204);
  });

  it("is safe for an empty table", () => {
    const db = new BotDatabase(":memory:");
    databases.push(db);
    expect(db.maintainNarrationRetentionChunk("SUI_USDC", now)).toBe(0);
  });
});
