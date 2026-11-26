import { expect, it } from "vitest";
import {
  BotDatabase,
  type SqlitePerfRecord,
} from "../packages/database/src/index.ts";

function withDatabase(
  instrumented: boolean,
  test: (db: BotDatabase, records: SqlitePerfRecord[]) => void,
) {
  const db = new BotDatabase(":memory:");
  const records: SqlitePerfRecord[] = [];
  const previous = BotDatabase.perfSink;
  BotDatabase.perfSink = instrumented ? (record) => records.push(record) : null;
  try {
    test(db, records);
  } finally {
    BotDatabase.perfSink = previous;
    db.close();
  }
}

it.each([false, true])("keeps three levels of writes (perf=%s)", (perf) => {
  withDatabase(perf, (db) => {
    const result = db.transaction(() => {
      db.set("outer", 1);
      return db.transaction(() => {
        db.set("middle", 2);
        return db.transaction(() => {
          db.set("inner", 3);
          return db.get("outer");
        });
      });
    });
    expect(result).toBe(1);
    expect(db.get("middle")).toBe(2);
    expect(db.get("inner")).toBe(3);
  });
});

it.each([false, true])(
  "rolls back only the failed savepoint (perf=%s)",
  (perf) => {
    withDatabase(perf, (db) => {
      db.transaction(() => {
        db.set("value", "outer");
        expect(() =>
          db.transaction(() => {
            db.set("value", "inner");
            db.transaction(() => db.set("third-level", true));
            throw new Error("inner failed");
          }),
        ).toThrow("inner failed");
        expect(db.get("value")).toBe("outer");
        expect(db.get("third-level")).toBeUndefined();
        db.transaction(() => db.set("after", true));
      });
      expect(db.get("value")).toBe("outer");
      expect(db.get("after")).toBe(true);
    });
  },
);

it.each([false, true])("rolls back a failed mock cycle (perf=%s)", (perf) => {
  withDatabase(perf, (db, records) => {
    db.set("price", 1);
    expect(() =>
      db.transaction(() => {
        db.set("price", 2);
        db.transaction(() => db.append("risk_events", "risk", { price: 2 }));
        throw new Error("cycle failed");
      }),
    ).toThrow("cycle failed");
    expect(db.get("price")).toBe(1);
    expect(db.history("risk_events", 10)).toEqual([]);
    if (perf) {
      expect(records.filter((record) => record.commitMs !== null)).toEqual([]);
      expect(
        records.findLast((record) => record.op === "transaction"),
      ).toMatchObject({
        ok: false,
        rollbackMs: expect.any(Number),
      });
    }
  });
});

it("commits a mock cycle once with the same write order and contents", () => {
  withDatabase(true, (db, records) => {
    const cycle = (target: BotDatabase) => {
      target.set("price", 2);
      expect(target.get("price")).toBe(2);
      target.transaction(() =>
        target.append("risk_events", "risk", { price: 2 }, 123),
      );
      target.set("price", 3);
    };
    const writes = (events: SqlitePerfRecord[]) =>
      events
        .filter((record) => record.op !== "transaction")
        .map(({ op, table, key, rows }) => ({ op, table, key, rows }));
    cycle(db);
    const standaloneWrites = writes(records);
    withDatabase(true, (batched, batchedRecords) => {
      batched.transaction(() => cycle(batched));
      expect(writes(batchedRecords)).toEqual(standaloneWrites);
      expect(batched.get("price")).toBe(db.get("price"));
      expect(batched.history("risk_events", 10)).toEqual(
        db.history("risk_events", 10),
      );
      expect(
        batchedRecords.filter((record) => record.commitMs !== null),
      ).toEqual([
        expect.objectContaining({
          op: "transaction",
          ok: true,
          beginMs: expect.any(Number),
          bodyMs: expect.any(Number),
          commitMs: expect.any(Number),
        }),
      ]);
    });
  });
});
