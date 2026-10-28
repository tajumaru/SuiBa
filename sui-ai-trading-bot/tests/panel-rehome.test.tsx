import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  ConnectivityPanel,
  ConnectivityStrip,
  connectivityStatus,
} from "../apps/dashboard/src/ConnectivityPanel.tsx";
import { initialPaperSafety } from "../packages/shared/src/paper-recovery.ts";

function fixture() {
  const db = new BotDatabase(":memory:");
  return { db, m: new OperationMonitor(db) };
}

it("derives the healthy message, tone and order gate from one status", () => {
  const { db, m } = fixture();
  db.set("runtime", { ...db.runtime(), running: true });
  m.market(Date.now());
  const status = connectivityStatus(m.safetySnapshot());
  expect(status.allowed).toBe(true);
  expect(status.tone).toBe("ok");
  expect(status.message).toContain("通信・運用状態は正常です");
  expect(status.connectivityLabel).toBe("正常");
  expect(status.botStateLabel).toBe("正常");
  db.close();
});

it("marks communication failure as an alert with orders blocked", () => {
  const { db, m } = fixture();
  db.set("runtime", { ...db.runtime(), running: true });
  db.set("paper_safety", {
    ...initialPaperSafety(),
    connectivity: "DEGRADED",
  });
  const status = connectivityStatus(m.safetySnapshot());
  expect(status.allowed).toBe(false);
  expect(status.tone).toBe("alert");
  expect(status.message).toContain("通信異常を検出しました");
  expect(status.connectivityLabel).toBe("通信異常");
  db.close();
});

it("keeps recovery cautious and never claims a premature resume", () => {
  const { db, m } = fixture();
  db.set("paper_safety", {
    ...initialPaperSafety(),
    connectivity: "RECOVERING",
    resumePending: true,
    healthyCycles: 1,
  });
  const status = connectivityStatus(m.safetySnapshot());
  expect(status.allowed).toBe(false);
  expect(status.tone).toBe("caution");
  expect(status.message).toContain("安全確認中");
  expect(status.message).not.toContain("再開しました");
  db.close();
});

it("treats safety and emergency stops as alerts with a no-auto-resume message", () => {
  const { db, m } = fixture();
  db.set("runtime", { ...db.runtime(), error: "MARKET_DATA_STALLED" });
  const abnormal = connectivityStatus(m.safetySnapshot());
  expect(abnormal.tone).toBe("alert");
  expect(abnormal.botStateLabel).toBe("異常停止");
  expect(abnormal.message).toContain("安全停止中です");
  expect(abnormal.message).toContain("自動再開しません");
  db.set("runtime", { ...db.runtime(), error: null, emergency: true });
  const emergency = connectivityStatus(m.safetySnapshot());
  expect(emergency.tone).toBe("alert");
  expect(emergency.botStateLabel).toBe("緊急停止");
  expect(emergency.message).toContain("緊急停止中です");
  db.close();
});

it("keeps a manual stop neutral and a stale snapshot unknown", () => {
  const { db, m } = fixture();
  const manual = connectivityStatus(m.safetySnapshot());
  expect(manual.tone).toBe("neutral");
  expect(manual.allowed).toBe(false);
  expect(manual.message).toContain("PAPER Botは停止中です");
  const stale = connectivityStatus(m.safetySnapshot(), true);
  expect(stale.tone).toBe("unknown");
  expect(stale.allowed).toBe(false);
  expect(stale.connectivityLabel).toBe("状態取得失敗");
  expect(stale.botStateLabel).toBe("状態取得失敗");
  expect(stale.message).toContain("Botの稼働・注文可否は未確認です");
  db.close();
});

const DETAIL_LABELS = [
  "現在の通信状態",
  "PAPER Botの状態",
  "新規注文",
  "最後の安全停止理由",
  "最新のAPIエラー",
  "復旧確認",
  "最終正常取得",
];

it("keeps the overview brief and reserves diagnostic details for the panel", () => {
  const { db, m } = fixture();
  db.set("runtime", { ...db.runtime(), running: true });
  db.set("paper_safety", {
    ...initialPaperSafety(),
    connectivity: "DEGRADED",
  });
  const safety = m.safetySnapshot();
  const strip = renderToStaticMarkup(<ConnectivityStrip safety={safety} />);
  expect(strip).toContain('aria-label="通信とPAPER注文の状態"');
  expect(strip).toContain('role="status"');
  expect(strip).toContain('aria-live="polite"');
  expect(strip).toContain("tone-alert");
  expect(strip).toContain("通信が不安定なため、新しい注文を止めています");
  expect(strip).not.toContain("connectivity-chips");
  expect(strip).not.toContain("<details");
  for (const label of DETAIL_LABELS) expect(strip).not.toContain(label);
  // The strip and the full panel render the same details and message:
  // one derivation, so the two surfaces cannot drift apart.
  const panel = renderToStaticMarkup(<ConnectivityPanel safety={safety} />);
  for (const label of DETAIL_LABELS) expect(panel).toContain(label);
  expect(panel).toContain(connectivityStatus(safety).message);
  db.close();
});

it("summarizes recovery without repeating its technical requirements", () => {
  const { db, m } = fixture();
  db.set("paper_safety", {
    ...initialPaperSafety(),
    connectivity: "RECOVERING",
    resumePending: true,
    healthyCycles: 1,
  });
  const safety = m.safetySnapshot();
  const note = "復旧条件をすべて満たした場合にPAPERのみ再開します";
  const strip = renderToStaticMarkup(
    <ConnectivityStrip safety={safety} onOpenDiagnostics={() => {}} />,
  );
  expect(strip).toContain("通信の復旧を確認中です。注文は止めています");
  expect(strip).toContain("検証を見る");
  expect(strip).not.toContain(note);
  expect(renderToStaticMarkup(<ConnectivityPanel safety={safety} />)).toContain(
    note,
  );
  db.close();
});

it("keeps diagnostics on the operations tab without a duplicate overview status card", () => {
  const main = readFileSync(resolve("apps/dashboard/src/main.tsx"), "utf8");
  // The fixed header already provides the overview's current status.
  expect(main).toContain('activeTab === "Overview"');
  expect(main).not.toContain("<ConnectivityStrip");
  // Neither full panel follows the reader across tabs any more.
  expect(main).not.toContain("MarketDataPanel");
  expect(main).not.toContain("<ConnectivityPanel");
  // The tab-independent emergency notice stays visible on every tab.
  expect(main).not.toContain("<RecoveryGuidance");
  const operations = readFileSync(
    resolve("apps/dashboard/src/OperationsPanel.tsx"),
    "utf8",
  );
  // Exactly one market panel on the operations tab, inside the
  // diagnostics details (layering details are covered by
  // operations-layers.test.tsx).
  expect(operations.match(/<MarketDataPanel/g)).toHaveLength(1);
  expect(operations.indexOf("<MarketDataPanel")).toBeGreaterThan(
    operations.indexOf('id="operation-diagnostics"'),
  );
});
