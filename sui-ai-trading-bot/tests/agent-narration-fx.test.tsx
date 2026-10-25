import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentPoseFx } from "../apps/dashboard/src/AgentNarration.tsx";
import type { AgentPose } from "../apps/dashboard/src/agentNarration.ts";

const POSES: AgentPose[] = ["normal", "point", "pointSmile", "sleep"];

describe("agent pose expression overlay", () => {
  it("keys the fx layer to the current pose", () => {
    for (const pose of POSES) {
      const html = renderToStaticMarkup(<AgentPoseFx pose={pose} />);
      expect(html).toContain('class="agent-feed-fx"');
      expect(html).toContain(`data-pose="${pose}"`);
      expect(html).toContain('aria-hidden="true"');
    }
  });

  it("renders one effect group for each expressive pose", () => {
    const html = renderToStaticMarkup(<AgentPoseFx pose="sleep" />);
    // Sleep: three floating Z letters and the snot bubble.
    expect(html).toContain("fx-g-sleep");
    expect(html.match(/agent-feed-fx-zzz/g)).toHaveLength(3);
    expect(html).toContain("agent-feed-fx-noseb");
    // Point: two twinkling four-point stars at the fingertip.
    expect(html).toContain("fx-g-point");
    expect(html.match(/agent-feed-fx-spark/g)).toHaveLength(2);
    // Smile: a musical note and a small star.
    expect(html).toContain("fx-g-smile");
    expect(html).toContain("agent-feed-fx-note");
    expect(html).toContain("♪");
    expect(html).toContain("agent-feed-fx-star");
  });

  it("switches the visible group by pose in the stylesheet", () => {
    const css = readFileSync(
      new URL("../apps/dashboard/src/style.css", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    for (const [pose, group] of [
      ["sleep", "fx-g-sleep"],
      ["point", "fx-g-point"],
      ["pointSmile", "fx-g-smile"],
    ] as const) {
      expect(css).toContain(
        `.agent-feed-fx[data-pose="${pose}"] .${group} {\n  display: block;`,
      );
    }
    // Groups stay hidden unless their pose is active, and the normal
    // pose has no display rule at all.
    expect(css).toContain(".agent-feed-fx-grp {\n  position: absolute;");
    expect(css).not.toContain('data-pose="normal"]');
  });

  it("animates only when reduced motion is not requested", () => {
    const css = readFileSync(
      new URL("../apps/dashboard/src/style.css", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const noPreference = css.slice(
      css.indexOf("@media (prefers-reduced-motion: no-preference)"),
    );
    for (const keyframes of [
      "agent-feed-fx-zfloat",
      "agent-feed-fx-breath",
      "agent-feed-fx-twinkle",
      "agent-feed-fx-floatup",
    ]) {
      expect(noPreference).toContain(`@keyframes ${keyframes}`);
    }
    // Under reduce the effects rest as faint still marks.
    expect(css).toContain(".agent-feed-fx-noseb {\n    opacity: 0.9;");
  });
});
