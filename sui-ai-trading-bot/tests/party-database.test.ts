import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { partyLevel } from "../packages/shared/src/party.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { SHADOW_PROMPT_VERSION } from "../apps/worker/src/shadow.ts";
import type { CandidateAudit } from "../packages/shared/src/operations.ts";

const refresh = (db: BotDatabase) =>
  Object.fromEntries(
    db.refreshParty(0, SHADOW_PROMPT_VERSION).map((r) => [r.member, r.count]),
  );

it("seeds the shield from old audits and retains the counter after pruning", () => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-party-"));
  const path = join(dir, "bot.sqlite");
  let db = new BotDatabase(path);
  try {
    const rejection = {
      id: "old",
      timestamp: 1,
      side: "BUY",
      finalAction: "WAIT",
      profitGuard: { evaluated: true, allowed: false },
    } as CandidateAudit;
    db.close();
    using sql = new DatabaseSync(path);
    sql.exec(
      "DROP TRIGGER rpg_shield_insert; DROP TRIGGER rpg_shield_update; DROP TABLE rpg_party",
    );
    sql
      .prepare("INSERT INTO operation_candidates VALUES(?,?,?)")
      .run(rejection.id, 1, JSON.stringify(rejection));
    db = new BotDatabase(path);
    expect(refresh(db).shield).toBe(1);
    db.putCandidate({ ...rejection, id: "sell", side: "SELL" });
    db.putCandidate({ ...rejection, id: "buy", finalAction: "PENDING" });
    db.putCandidate({ ...rejection, id: "buy" });
    db.putCandidate({ ...rejection, id: "buy" });
    sql.exec("DELETE FROM operation_candidates");
    db.close();
    db = new BotDatabase(path);
    expect(refresh(db).shield).toBe(2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps the forecast count and counts the current review's valid joined advice", () => {
  const db = new BotDatabase(":memory:");
  try {
    expect(db.refreshParty(300, SHADOW_PROMPT_VERSION)).toContainEqual({
      member: "forecast",
      count: 300,
      notifiedLevel: 4,
    });
    expect(refresh(db).forecast).toBe(300);
    const advice = {
      promptVersion: SHADOW_PROMPT_VERSION,
      status: "OK",
      action: "WAIT",
      candleTimestamp: 600,
      price: 1,
    };
    db.append(
      "strategy_decisions",
      "valid",
      { evidence: { candleTimestamp: 600 } },
      1,
    );
    db.append(
      "strategy_decisions",
      "old",
      { evidence: { candleTimestamp: 600 } },
      1,
    );
    db.append("shadow_decisions", "valid", advice, 1);
    db.append("shadow_decisions", "missing", advice, 1);
    db.append(
      "shadow_decisions",
      "old",
      { ...advice, promptVersion: "old" },
      1,
    );
    expect(refresh(db).shadow).toBe(1);
    expect(
      db.refreshParty(0, "another-version").find((r) => r.member === "shadow")
        ?.count,
    ).toBe(1);
  } finally {
    db.close();
  }
});


it("baselines the healer and sage and retains the recovery count", () => {
  const db = new BotDatabase(":memory:");
  try {
    db.set("paper_safety", { autoRecoveryCount: 21 });
    const records = db.refreshParty(0, SHADOW_PROMPT_VERSION);
    expect(records).toContainEqual({ member: "healer", count: 21, notifiedLevel: 5 });
    expect(records).toContainEqual({ member: "sage", count: 0, notifiedLevel: 999 });
    const healer = records.find((r) => r.member === "healer")!;
    const sage = records.find((r) => r.member === "sage")!;
    expect(partyLevel(healer.member, healer.count).level).toBe(5);
    expect(partyLevel(sage.member, sage.count).level).toBe(999);

    db.set("paper_safety", { autoRecoveryCount: 2 });
    expect(refresh(db).healer).toBe(21);
  } finally {
    db.close();
  }
});

it("uses zero recoveries when the safety state is absent or invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-party-"));
  const path = join(dir, "bot.sqlite");
  const db = new BotDatabase(path);
  try {
    expect(refresh(db).healer).toBe(0);
    db.set("paper_safety", { autoRecoveryCount: "21" });
    expect(refresh(db).healer).toBe(0);
    using sql = new DatabaseSync(path);
    sql.prepare("UPDATE bot_runtime_state SET json=? WHERE key=?")
      .run("{broken", "paper_safety");
    expect(refresh(db).healer).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
