import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ShadowTodayLine } from "../apps/dashboard/src/OverviewTab.tsx";
import { shadowTodaySummary } from "../apps/worker/src/shadow-summary.ts";
import { BotDatabase } from "../packages/database/src/index.ts";

const now = Date.UTC(2026, 10, 14, 3);
const dbs: BotDatabase[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const db of dbs.splice(0)) db.close();
});

function recordRule(
  db: BotDatabase,
  id: string,
  at: number,
  overrides: Record<string, boolean> = {},
) {
  db.append(
    "strategy_decisions",
    id,
    {
      action: "WAIT",
      evidence: {
        candleTimestamp: Math.floor(at / 1000),
        conditions: {
          emaUp: false,
          rsiRecovery: true,
          histogramImproving: true,
          latestVolumePositive: true,
          previousVolumePositive: true,
          volumeChangeExceeded: false,
          ...overrides,
        },
      },
    },
    at,
  );
}

function recordShadow(
  db: BotDatabase,
  id: string,
  at: number,
  status: "OK" | "ERROR" | "SKIPPED_BUDGET",
  action: "BUY" | "WAIT" = "BUY",
) {
  db.append(
    "shadow_decisions",
    id,
    {
      cycleId: id,
      candleTimestamp: Math.floor(at / 1000),
      status,
      action,
      snapshot: { evidence: { inputs: { price: 2 } } },
    },
    at,
  );
}

it("counts only the current daily-key window and reuses the review base split", () => {
  const db = new BotDatabase(":memory:");
  dbs.push(db);
  recordRule(db, "ai-only", now);
  recordRule(db, "both", now + 1, { emaUp: true });
  recordShadow(db, "ai-only", now, "OK");
  recordShadow(db, "both", now + 1, "OK");
  recordShadow(db, "error", now + 2, "ERROR");
  recordShadow(db, "budget", now + 3, "SKIPPED_BUDGET");
  recordShadow(db, "yesterday", now - 86400000, "ERROR");

  expect(shadowTodaySummary(db, now)).toEqual({
    total: 4,
    aiOnlyBuy: 1,
    errors: 1,
    lastDecisionAt: now + 3,
  });
});

it("renders no disabled line, a compact zero line, and the exact populated line", () => {
  expect(renderToStaticMarkup(createElement(ShadowTodayLine, { summary: null }))).toBe("");
  expect(
    renderToStaticMarkup(
      createElement(ShadowTodayLine, {
        summary: { total: 0, aiOnlyBuy: 0, errors: 0, lastDecisionAt: null },
      }),
    ),
  ).toContain("影 本日 0件</p>");
  expect(
    renderToStaticMarkup(
      createElement(ShadowTodayLine, {
        summary: { total: 7, aiOnlyBuy: 2, errors: 1, lastDecisionAt: now },
      }),
    ),
  ).toContain("影 本日 7件（AIのみBUY 2件・エラー 1件）</p>");
});
