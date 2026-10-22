import { it, expect } from "vitest";
import fs from "node:fs";
import {
  auditedChartGaps,
  verifiedDisplayRepairs,
} from "../packages/shared/src/chart-gap-audit.ts";
import { classifyChartGap } from "../packages/shared/src/chart-gaps.ts";
import { chartGapQuality } from "../packages/shared/src/chart-gap-quality.ts";
import { parseDeepBook } from "../packages/market-data/src/deepbook.ts";
it("replays all 48 exact gaps and keeps reconstruction provenance", () => {
  const r = JSON.parse(
    fs.readFileSync("docs/evidence/chart-gaps-48/report.json", "utf8"),
  );
  const e = JSON.parse(
    fs.readFileSync("docs/evidence/chart-gaps-48/responses.json", "utf8"),
  );
  const c = parseDeepBook(
    { candles: e.five },
    300,
    e.completedAt,
  ) as import("../packages/shared/src/index.ts").Candle[];
  const q = chartGapQuality(c, r.from, r.to, 300);
  expect(q.expected).toBe(2016);
  expect(q.received).toBe(1968);
  expect(q.entries.map((g) => g.timestamp)).toEqual(
    auditedChartGaps.map((g) => g.timestamp),
  );
  expect(r.originalDuplicates).toBe(0);
  expect(r.invalidOriginal).toBe(0);
  const fixed = chartGapQuality(
    [...c, ...verifiedDisplayRepairs],
    r.from,
    r.to,
    300,
  );
  expect(fixed.missing).toBe(0);
  expect(fixed.reconstructed).toBe(48);
  expect(fixed.received).toBe(2016);
  expect(
    verifiedDisplayRepairs.every(
      (c) =>
        c.provenance?.origin === "NO_INDEXED_TRADES" &&
        c.volume === 0 &&
        c.open === c.close &&
        c.provenance.evidence.length > 0,
    ),
  ).toBe(true);
});
it("never treats a missing OHLCV row alone as proof of no trades", () => {
  const input = {
    timestamp: 1000,
    trades: null,
    complete: false,
    validRange: false,
    indexedThrough: 0,
    minuteCount: 0,
    fivePresent: false,
  };
  expect(classifyChartGap(input)).toBe("UNKNOWN");
  expect(
    classifyChartGap({
      ...input,
      trades: [],
      complete: true,
      validRange: true,
    }),
  ).toBe("UNKNOWN");
  expect(
    classifyChartGap({
      ...input,
      trades: [],
      complete: true,
      validRange: true,
      indexedThrough: 1300000,
    }),
  ).toBe("NO_TRADES_VERIFIED");
  expect(classifyChartGap({ ...input, trades: [{ timestamp: 1000001 }] })).toBe(
    "INDEXER_MISSING",
  );
  expect(classifyChartGap({ ...input, excludedByPaging: true })).toBe(
    "PAGINATION_GAP",
  );
  expect(classifyChartGap({ ...input, invalid: true })).toBe("DATA_INVALID");
});
it("unknown intervals remain missing", () => {
  const q = chartGapQuality([], 300, 900, 300);
  expect(q.unknown).toBe(2);
  expect(q.reconstructed).toBe(0);
  expect(q.missing).toBe(2);
});
