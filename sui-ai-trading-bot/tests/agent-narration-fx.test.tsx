import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentPoseFx,
  AgentStageArtwork,
} from "../apps/dashboard/src/AgentNarration.tsx";
import type { AgentPose } from "../apps/dashboard/src/agentNarration.ts";

const POSES: AgentPose[] = ["normal", "point", "pointSmile", "sleep", "laptop"];

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
    // and laptop poses have no display rule at all.
    expect(css).toContain(".agent-feed-fx-grp {\n  position: absolute;");
    expect(css).not.toContain('data-pose="normal"]');
    expect(css).not.toContain('data-pose="laptop"]');
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

describe("agent laptop two-frame typing", () => {
  const readCss = () =>
    readFileSync(
      new URL("../apps/dashboard/src/style.css", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

  it("stacks a second frame only for the laptop pose", () => {
    const laptop = renderToStaticMarkup(<AgentStageArtwork pose="laptop" />);
    expect(laptop.match(/<img/g)).toHaveLength(2);
    expect(laptop).toContain('class="agent-feed-stage-typing"');
    expect(laptop).toContain("agent-white-laptop-typing");
    for (const pose of POSES.filter((p) => p !== "laptop")) {
      const html = renderToStaticMarkup(<AgentStageArtwork pose={pose} />);
      expect(html.match(/<img/g)).toHaveLength(1);
      expect(html).not.toContain("agent-feed-stage-typing");
    }
  });

  it("rests the typing frame invisible and flips it only with motion allowed", () => {
    const css = readCss();
    // Base rule: stacked on the base frame, invisible at rest.
    expect(css).toContain(
      ".agent-feed-stage img.agent-feed-stage-typing {\n  position: absolute;\n  inset: 0;\n  opacity: 0;\n}",
    );
    // The flip exists only inside a no-preference media block, on a
    // 0.52s cycle (about 0.26s per frame), riding the shared bob so
    // the two frames never drift apart.
    const noPreferenceAt = css.indexOf(
      "@media (prefers-reduced-motion: no-preference)",
    );
    expect(noPreferenceAt).toBeGreaterThanOrEqual(0);
    expect(css.indexOf("@keyframes agent-feed-typing")).toBeGreaterThan(
      noPreferenceAt,
    );
    const noPreference = css.slice(noPreferenceAt);
    expect(noPreference).toContain("agent-feed-typing 0.52s linear infinite");
    expect(noPreference).toContain("agent-feed-bob 3.2s ease-in-out infinite");
    // Before that block the typing frame is never animated.
    expect(css.slice(0, noPreferenceAt)).not.toContain("agent-feed-typing");
    // Under reduce the feed-wide rule kills every feed animation, so
    // the typing frame stays invisible and the base frame is still.
    expect(css).toContain(
      "@media (prefers-reduced-motion: reduce) {\n  .agent-feed *,\n  .agent-feed *::before,\n  .agent-feed *::after {\n    animation: none !important;",
    );
  });
});
