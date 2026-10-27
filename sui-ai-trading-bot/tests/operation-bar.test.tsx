import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BotEngine } from "../apps/worker/src/engine.ts";
import { OperationBar } from "../apps/dashboard/src/OperationBar.tsx";

type State = ReturnType<BotEngine["snapshot"]>;
type Runtime = State["runtime"];

const main = readFileSync(resolve("apps/dashboard/src/main.tsx"), "utf8");
const bar = readFileSync(
  resolve("apps/dashboard/src/OperationBar.tsx"),
  "utf8",
);
const css = readFileSync(
  resolve("apps/dashboard/src/style.css"),
  "utf8",
).replace(/\r\n/g, "\n");

function render(runtime: Partial<Runtime>, startBlocked: string[] = []) {
  return renderToStaticMarkup(
    <OperationBar
      runtime={
        { running: false, emergency: false, error: null, ...runtime } as Runtime
      }
      control={async () => null}
      onOpenStrategy={() => {}}
      startBlocked={startBlocked}
    />,
  );
}

describe("operation bar states", () => {
  it("shows 運用中 with a stop icon button that acts in place", () => {
    const html = render({ running: true });
    expect(html).toContain("PAPER運用：運用中");
    expect(html).toContain("operation-bar tone-ok");
    // Icon-only: the accessible name and title identify the action.
    expect(html).toContain(
      '<button type="button" class="operation-icon-button stop" aria-label="PAPER運用停止" title="PAPER運用停止">',
    );
    expect(html).toContain('stroke="#ff7d9c"');
    expect(html).not.toContain("<span>PAPER運用停止</span>");
    expect(html).not.toContain("PAPER運用開始");
    expect(html).not.toContain("解除の手順へ");
  });

  it("shows 停止中 with a direct start on the bar", () => {
    const html = render({});
    expect(html).toContain("PAPER運用：停止中");
    expect(html).toContain("operation-bar tone-caution");
    expect(html).toContain(
      '<button type="button" class="operation-icon-button start" aria-label="PAPER運用開始" title="PAPER運用開始">',
    );
    expect(html).toContain('stroke="#43dfb2"');
    expect(html).not.toContain("解除の手順へ");
    expect(html).not.toContain("今は開始できません");
    // The unified bar issues start and stop itself.
    expect(bar).toContain('control("start")');
    expect(bar).toContain('control("stop")');
  });

  it("disables the start and lists every reason while the editor gate blocks it", () => {
    const html = render({}, ["未保存の変更があります。テスト用の理由。"]);
    const startAt = html.indexOf('aria-label="PAPER運用開始"');
    const button = html.slice(
      html.lastIndexOf("<button", startAt),
      html.indexOf(">", startAt),
    );
    expect(button).toContain("disabled");
    expect(html).toContain("今は開始できません：");
    expect(html).toContain("未保存の変更があります。テスト用の理由。");
    // The block strip only ever explains a plain stop.
    expect(render({ running: true }, ["理由"])).not.toContain(
      "今は開始できません",
    );
    expect(render({ emergency: true }, ["理由"])).not.toContain(
      "今は開始できません",
    );
  });

  it("shows 緊急停止中 / 安全停止中 with a jump to the release steps", () => {
    const emergency = render({ emergency: true });
    expect(emergency).toContain("PAPER運用：緊急停止中");
    expect(emergency).toContain("operation-bar tone-alert");
    expect(emergency).toContain(
      '<button type="button" class="operation-icon-button release" aria-label="解除の手順へ" title="解除の手順へ">',
    );
    expect(emergency).toContain('stroke="#edc980"');
    const safety = render({ error: "UPSTREAM_HTTP_504" });
    expect(safety).toContain("PAPER運用：安全停止中");
    expect(safety).toContain("operation-bar tone-alert");
    expect(safety).toContain(
      '<button type="button" class="operation-icon-button release" aria-label="解除の手順へ" title="解除の手順へ">',
    );
    // A stopped state never offers the in-place stop or a start.
    expect(emergency).not.toContain("PAPER運用開始");
    expect(safety).not.toContain("PAPER運用開始");
    expect(emergency).not.toContain("PAPER運用停止");
    expect(safety).not.toContain("PAPER運用停止");
  });

  it("carries a state dot whose tone follows the state", () => {
    for (const [runtime, tone] of [
      [{ running: true }, "tone-ok"],
      [{}, "tone-caution"],
      [{ emergency: true }, "tone-alert"],
    ] as const) {
      const html = render(runtime);
      expect(html).toContain("operation-bar-dot");
      expect(html).toContain(`operation-bar ${tone}`);
    }
  });
});

describe("operation bar wiring (main.tsx)", () => {
  it("renders once, at the top of the logged-in content on every tab", () => {
    expect(main.match(/<OperationBar/g)).toHaveLength(1);
    const barAt = main.indexOf("<OperationBar");
    // Inside the data-gated content (so it appears with the first
    // snapshot, like the global notices), right under the title —
    // and not inside any single tab's branch.
    expect(barAt).toBeGreaterThan(main.indexOf('className="title"'));
    expect(barAt).toBeLessThan(main.indexOf('className="narration-tab"'));
    expect(barAt).toBeLessThan(main.indexOf('activeTab === "Strategy"'));
    // Before connecting, the login gate renders instead of the
    // app main, so the bar cannot appear on the login screen.
    expect(main).toContain("<LoginScreen");
    expect(barAt).toBeGreaterThan(
      main.indexOf('<main className="has-avatar">'),
    );
  });

  it("feeds the live runtime and jumps via the app tab switch", () => {
    expect(main).toContain("runtime={data.runtime}");
    expect(main).toContain("control={control}");
    expect(main).toContain('onOpenStrategy={() => setTab("Strategy")}');
  });

  it("feeds the bar the strategy editor's start blocks", () => {
    expect(main).toContain("startBlocked={startBlocked}");
    expect(main).toContain("onStartGateChange={setStartBlocked}");
  });

  it("stays a single slim line that cannot collide with the avatar dock spacing", () => {
    // In-flow (no fixed/sticky positioning) with a one-line
    // layout; the has-avatar clearances are untouched.
    const block = css.slice(
      css.indexOf(".operation-bar {"),
      css.indexOf(".operation-bar-state {"),
    );
    expect(block).toContain("display: flex;");
    expect(block).toContain("justify-content: space-between;");
    expect(block).not.toContain("position:");
    expect(css).toContain("nav.has-avatar {\n  padding-top: 70px;\n}");
  });

  it("keeps the bar buttons as compact icon-only squares", () => {
    expect(css).toContain(
      ".operation-bar .operation-icon-button {\n  width: 30px;\n  height: 30px;",
    );
    expect(css).toContain(
      "\n.operation-icon-button {\n  display: inline-flex;",
    );
    const block = css.slice(
      css.indexOf(".operation-bar .operation-icon-button {"),
      css.indexOf(".operation-bar .operation-icon-button svg"),
    );
    expect(block).not.toContain("min-height: 44px;");
    expect(block).not.toContain("min-width: 44px;");
  });
});
