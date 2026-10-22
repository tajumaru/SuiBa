import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { ConnectivityPanel } from "../apps/dashboard/src/ConnectivityPanel.tsx";
import { initialPaperSafety } from "../packages/shared/src/paper-recovery.ts";

it("separates communication degradation from hard stops and never claims premature recovery", () => {
  const db = new BotDatabase(":memory:"),
    m = new OperationMonitor(db);
  db.set("paper_safety", {
    ...initialPaperSafety(),
    connectivity: "RECOVERING",
    resumePending: true,
    healthyCycles: 1,
  });
  const render = (stale = false) =>
    renderToStaticMarkup(
      <ConnectivityPanel safety={m.safetySnapshot()} stale={stale} />,
    );
  expect(render()).toContain("安全確認中");
  expect(render()).toContain("注文禁止");
  expect(render()).not.toContain("PAPER検証を再開しました");
  db.set("runtime", { ...db.runtime(), emergency: true });
  expect(render()).toContain("緊急停止中");
  expect(render()).toContain("自動再開しません");
  expect(render(true)).toContain("状態不明");
  expect(render(true)).not.toContain("注文可能（");
  db.close();
});
it("shows resumed only for a confirmed transition with an open order gate", () => {
  const db = new BotDatabase(":memory:"),
    m = new OperationMonitor(db);
  db.set("runtime", { ...db.runtime(), running: true });
  m.market(Date.now());
  db.set("paper_safety", { ...initialPaperSafety(), recoveredAt: Date.now() });
  expect(
    renderToStaticMarkup(<ConnectivityPanel safety={m.safetySnapshot()} />),
  ).toContain("PAPER検証を再開しました");
  db.set("runtime", { ...db.runtime(), running: false });
  m.transition("MANUAL_STOP");
  expect(
    renderToStaticMarkup(<ConnectivityPanel safety={m.safetySnapshot()} />),
  ).not.toContain("PAPER検証を再開しました");
  db.close();
});
