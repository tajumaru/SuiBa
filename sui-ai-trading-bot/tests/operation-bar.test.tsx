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

function render(runtime: Partial<Runtime>) {
  return renderToStaticMarkup(
    <OperationBar
      runtime={
        { running: false, emergency: false, error: null, ...runtime } as Runtime
      }
      control={async () => null}
      onOpenStrategy={() => {}}
    />,
  );
}

describe("operation bar states", () => {
  it("shows 運用中 with a stop button that acts in place", () => {
    const html = render({ running: true });
    expect(html).toContain("PAPER運用：運用中");
    expect(html).toContain("operation-bar tone-ok");
    expect(html).toContain('<button type="button">停止</button>');
    expect(html).not.toContain("開始へ");
    expect(html).not.toContain("解除の手順へ");
  });

  it("shows 停止中 with a jump to the strategy tab, never a direct start", () => {
    const html = render({});
    expect(html).toContain("PAPER運用：停止中");
    expect(html).toContain("operation-bar tone-caution");
    expect(html).toContain('<button type="button">開始へ</button>');
    expect(html).not.toContain("解除の手順へ");
    // The bar has no start of its own: the only control command it
    // can issue is stop (see the wiring test below as well).
    expect(bar).not.toContain('control("start")');
    expect(bar).toContain('control("stop")');
  });

  it("shows 緊急停止中 / 安全停止中 with a jump to the release steps", () => {
    const emergency = render({ emergency: true });
    expect(emergency).toContain("PAPER運用：緊急停止中");
    expect(emergency).toContain("operation-bar tone-alert");
    expect(emergency).toContain('<button type="button">解除の手順へ</button>');
    const safety = render({ error: "UPSTREAM_HTTP_504" });
    expect(safety).toContain("PAPER運用：安全停止中");
    expect(safety).toContain("operation-bar tone-alert");
    expect(safety).toContain('<button type="button">解除の手順へ</button>');
    // A stopped state never offers the in-place stop or a start.
    expect(emergency).not.toContain("開始へ");
    expect(safety).not.toContain("開始へ");
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
    // Before connecting there is no main content at all, so the
    // bar cannot appear on the login screen.
    expect(main).toContain('<main className="login">');
    expect(barAt).toBeGreaterThan(main.indexOf('<main className="has-avatar">'));
  });

  it("feeds the live runtime and jumps via the app tab switch", () => {
    expect(main).toContain("runtime={data.runtime}");
    expect(main).toContain("control={control}");
    expect(main).toContain('onOpenStrategy={() => setTab("Strategy")}');
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
});
