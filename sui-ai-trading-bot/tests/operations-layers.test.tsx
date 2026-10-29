import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { ValidationRecorder } from "../apps/worker/src/validation.ts";
import { OperationsView } from "../apps/dashboard/src/OperationsPanel.tsx";
import type { OperationsSnapshot } from "../apps/dashboard/src/operationsTypes.ts";

/**
 * The operations tab is layered: an everyday layer (validation
 * control, summary, alert banners, KPIs), a report layer (24h / 7d
 * reports), and a diagnostics layer inside the existing
 * #operation-diagnostics details (market-data connection, DeepBook
 * validation, then the long-standing diagnostics sections). These
 * tests pin that arrangement so a future edit cannot quietly pull a
 * diagnostics block back into the always-visible layers — or bury an
 * alert banner inside the collapsed details.
 */
function fixture() {
  const db = new BotDatabase(":memory:");
  const status = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const engine = new BotEngine(
    db,
    { candles: async () => [] },
    {
      getQuote: async () => {
        throw Error("NO_TRADES");
      },
      validateQuote: async () => false,
    },
    { health: async () => status, status },
  );
  engine.monitor.boot();
  const recorder = new ValidationRecorder(db);
  const data: OperationsSnapshot = {
    ...engine.monitor.snapshot(),
    validation: recorder.report(),
  };
  const state = {
    ...engine.snapshot(),
    marketData: {
      configured: "auto",
      source: "DeepBook Indexer",
      fallback: false,
      lastSuccessAt: Date.now(),
      latencyMs: 120,
      reason: null,
      healthy: true,
      bookAt: null,
      bid: null,
      ask: null,
      spread: null,
    },
  };
  return { db, data, state };
}

it("keeps the control, summary and KPIs outside the diagnostics details, in layer order", () => {
  const { db, data, state } = fixture();
  const html = renderToStaticMarkup(
    <OperationsView data={data} state={state} />,
  );
  const diag = html.indexOf('id="operation-diagnostics"');
  expect(diag).toBeGreaterThan(-1);
  const control = html.indexOf("運用検証コントロール");
  const summary = html.indexOf('aria-label="運用状態"');
  const kpi = html.indexOf('aria-label="主要KPI"');
  for (const at of [control, summary, kpi]) {
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(diag);
  }
  expect(control).toBeLessThan(summary);
  expect(summary).toBeLessThan(kpi);
  db.close();
});

it("puts the full report, market panel, DeepBook validation and then the existing diagnostics inside the details", () => {
  const { db, data, state } = fixture();
  const html = renderToStaticMarkup(
    <OperationsView data={data} state={state} />,
  );
  const diag = html.indexOf('id="operation-diagnostics"');
  const report = html.indexOf("24時間・7日間の検証レポート");
  const market = html.indexOf('aria-label="市場データ接続"');
  const deepbook = html.indexOf('aria-label="DeepBook 24時間検証"');
  const connectivity = html.indexOf("通信とPAPER注文");
  const timing = html.indexOf('aria-label="市場データ取得タイミング"');
  expect(report).toBeGreaterThan(diag);
  expect(market).toBeGreaterThan(report);
  expect(deepbook).toBeGreaterThan(market);
  expect(connectivity).toBeGreaterThan(deepbook);
  expect(timing).toBeGreaterThan(deepbook);
  db.close();
});

it("keeps the ledger-mismatch alert banner outside the diagnostics details", () => {
  const { db, data, state } = fixture();
  const broken: OperationsSnapshot = {
    ...data,
    accounting: {
      ...data.accounting,
      ledger: { ...data.accounting.ledger, ok: false },
    },
  };
  const html = renderToStaticMarkup(
    <OperationsView data={broken} state={state} />,
  );
  const banner = html.indexOf("残高・損益の不整合を検出しました");
  const diag = html.indexOf('id="operation-diagnostics"');
  expect(banner).toBeGreaterThan(-1);
  expect(banner).toBeLessThan(diag);
  db.close();
});
