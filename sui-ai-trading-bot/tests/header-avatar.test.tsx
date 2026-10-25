import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentHeaderAvatar,
  AgentNarrationFeed,
} from "../apps/dashboard/src/AgentNarration.tsx";
import type { AgentPose } from "../apps/dashboard/src/agentNarration.ts";
import type { OperationsSnapshot } from "../apps/dashboard/src/operationsTypes.ts";

const POSES: AgentPose[] = ["normal", "point", "pointSmile", "sleep", "laptop"];

// The pill shows the feed stage's old status labels verbatim, and
// the dot follows the pose: green while watching at the laptop,
// gold while pointing, grey while stopped or unconfirmed.
const EXPECTED: Record<AgentPose, { label: string; dot: string }> = {
  normal: { label: "様子を見ています", dot: "tone-stop" },
  point: { label: "条件が近づいています", dot: "tone-near" },
  pointSmile: { label: "売買を記録しました", dot: "tone-near" },
  sleep: { label: "止まっています", dot: "tone-stop" },
  laptop: { label: "様子を見ています", dot: "tone-run" },
};

describe("agent header avatar", () => {
  it("keys the circle to the current pose and labels the pill", () => {
    for (const pose of POSES) {
      const html = renderToStaticMarkup(<AgentHeaderAvatar pose={pose} />);
      expect(html).toContain('class="agent-avatar-dock"');
      expect(html).toContain(`class="agent-avatar pose-${pose}"`);
      expect(html).toContain(`data-pose="${pose}"`);
      // The pill is the status surface (the artwork is decorative).
      expect(html).toContain('class="agent-avatar-pill"');
      expect(html).toContain('role="status"');
      expect(html).toContain(EXPECTED[pose].label);
      expect(html).toContain(`class="agent-avatar-dot ${EXPECTED[pose].dot}"`);
    }
  });

  it("keeps only the coarse marks: a Zzz and a star, keyed by CSS", () => {
    const html = renderToStaticMarkup(<AgentHeaderAvatar pose="sleep" />);
    expect(html).toContain('class="agent-avatar-zzz"');
    expect(html).toContain("Zzz");
    expect(html).toContain('class="agent-avatar-star"');
    expect(html).toContain("✦");
    // The detailed stage overlay (snot bubble, positioned sparks)
    // does not move into the avatar.
    expect(html).not.toContain("agent-feed-fx");
    expect(html).not.toContain("noseb");
  });

  it("stacks a second frame only for the laptop pose", () => {
    const laptop = renderToStaticMarkup(<AgentHeaderAvatar pose="laptop" />);
    expect(laptop.match(/<img/g)).toHaveLength(2);
    expect(laptop).toContain('class="agent-avatar-typing"');
    expect(laptop).toContain("agent-white-laptop-typing");
    for (const pose of POSES.filter((p) => p !== "laptop")) {
      const html = renderToStaticMarkup(<AgentHeaderAvatar pose={pose} />);
      expect(html.match(/<img/g)).toHaveLength(1);
      expect(html).not.toContain("agent-avatar-typing");
    }
  });
});

describe("agent header avatar stylesheet", () => {
  const css = readFileSync(
    new URL("../apps/dashboard/src/style.css", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const section = css.slice(
    css.indexOf("/* Agent header avatar:"),
    css.indexOf("/* Agent narration feed:"),
  );

  it("sticks a 92px circle to the top centre, half over the header at rest", () => {
    // The dock is sticky, not positioned against the header: its
    // containing block spans the whole page, so after the header
    // scrolls away it stays 9px below the viewport top. The
    // negative margins centre the resting dock on the header's
    // bottom edge (half over it), exactly where it used to float.
    expect(section).toContain(
      ".agent-avatar-dock {\n  position: sticky;\n  top: 9px;\n  z-index: 5;",
    );
    expect(section).toContain("width: fit-content;");
    expect(section).toContain("margin: -64px auto -64px;");
    expect(section).toContain("pointer-events: none;");
    expect(section).not.toContain("translate(-50%, 50%)");
    expect(section).toContain(
      ".agent-avatar {\n  position: relative;\n  width: 92px;\n  height: 92px;\n  border-radius: 50%;",
    );
    // The artwork is clipped to the circle by the bob wrapper.
    expect(section).toContain(
      ".agent-avatar-bob {\n  position: absolute;\n  inset: 0;\n  border-radius: 50%;\n  overflow: hidden;\n}",
    );
    expect(section).toContain("object-fit: cover;");
  });

  it("shows the Zzz / star marks per pose and colours the pill dot", () => {
    expect(section).toContain(
      ".agent-avatar.pose-sleep .agent-avatar-zzz {\n  opacity: 0.9;\n}",
    );
    expect(section).toContain(".agent-avatar.pose-point .agent-avatar-star,");
    expect(section).toContain(
      ".agent-avatar-dot.tone-run {\n  background: #43dfb2;\n}",
    );
    expect(section).toContain(
      ".agent-avatar-dot.tone-near {\n  background: #ffd166;\n}",
    );
    expect(section).toContain(
      ".agent-avatar-dot.tone-stop {\n  background: #8fa7b9;\n}",
    );
  });

  it("animates only when reduced motion is not requested", () => {
    const mediaAt = section.indexOf(
      "@media (prefers-reduced-motion: no-preference)",
    );
    expect(mediaAt).toBeGreaterThanOrEqual(0);
    // Every avatar animation and keyframes lives inside that block:
    // before it, nothing in the section animates at all, so under
    // reduce the avatar rests still on the base (first) frame.
    expect(section.slice(0, mediaAt)).not.toContain("animation:");
    expect(section.slice(0, mediaAt)).not.toContain("@keyframes");
    const motion = section.slice(mediaAt);
    expect(motion).toContain("agent-avatar-bob 3.2s ease-in-out infinite");
    expect(motion).toContain("agent-avatar-typing 0.52s linear infinite");
    for (const keyframes of [
      "agent-avatar-bob",
      "agent-avatar-typing",
      "agent-avatar-zzz",
      "agent-avatar-star",
    ]) {
      expect(motion).toContain(`@keyframes ${keyframes}`);
    }
    // The typing frame rests invisible outside the motion block.
    expect(section).toContain(
      ".agent-avatar-bob img.agent-avatar-typing {\n  opacity: 0;\n}",
    );
  });

  it("keeps following content clear of the dock", () => {
    // Desktop: the tab bar (rendered only while connected, like
    // the avatar) carries the clearance.
    expect(css).toContain("nav.has-avatar {\n  padding-top: 78px;\n}");
    // Mobile: the tab bar is fixed, so the page top carries it.
    expect(css).toContain("main.has-avatar {");
    expect(css).toContain("padding-top: 78px;");
  });
});

describe("narration feed after the stage removal", () => {
  const stopped = {
    status: "STOPPED",
    decision: null,
    events: [],
    candidates: [],
  } as unknown as OperationsSnapshot;

  it("renders the feed without any stage, artwork or pose label", () => {
    const html = renderToStaticMarkup(
      <AgentNarrationFeed data={stopped} stale={false} />,
    );
    // The section keeps its accessible name and its entries area…
    expect(html).toContain('aria-label="エージェント実況"');
    expect(html).toContain("実況を準備中です");
    expect(html).toContain("agent-feed-note");
    // …but the stage block (artwork, heading, pose label) is gone:
    // the character and its status live in the header avatar now.
    expect(html).not.toContain("<img");
    expect(html).not.toContain("agent-feed-stage");
    expect(html).not.toContain("Botの実況");
    expect(html).not.toContain("様子を見ています");
  });

  it("leaves no stage or expression-overlay code behind", () => {
    const component = readFileSync(
      resolve("apps/dashboard/src/AgentNarration.tsx"),
      "utf8",
    );
    expect(component).not.toContain("agent-feed-stage");
    expect(component).not.toContain("AgentPoseFx");
    expect(component).not.toContain("AgentStageArtwork");
    const css = readFileSync(
      new URL("../apps/dashboard/src/style.css", import.meta.url),
      "utf8",
    );
    expect(css).not.toContain(".agent-feed-stage");
    expect(css).not.toContain(".agent-feed-fx");
    expect(css).not.toContain(".agent-feed-head");
  });

  it("reports the derived pose to the app shell", () => {
    const component = readFileSync(
      resolve("apps/dashboard/src/AgentNarration.tsx"),
      "utf8",
    );
    expect(component).toContain("onPoseChange?.(pose)");
  });
});

describe("agent header avatar wiring (main.tsx)", () => {
  const main = readFileSync(resolve("apps/dashboard/src/main.tsx"), "utf8");

  it("renders the avatar at the app top, fed by the narration feed", () => {
    expect(main).toContain("{token && <AgentHeaderAvatar pose={agentPose} />}");
    expect(main).toContain("onPoseChange={setAgentPose}");
    expect(main).toContain('useState<AgentPose>("normal")');
  });

  it("renders the avatar outside the header, as its sibling", () => {
    // The dock can only stick for the whole page if it is not a
    // child of the header (a sticky element travels only within
    // its parent), so the single render site sits between the
    // header and the tab bar, under the app root.
    const avatarAt = main.indexOf("<AgentHeaderAvatar");
    expect(avatarAt).toBeGreaterThan(main.indexOf("</header>"));
    expect(avatarAt).toBeLessThan(main.indexOf("<nav"));
  });

  it("renders no avatar at all before connecting", () => {
    // The single render site is guarded by the token, and the
    // login screen keeps its own untouched layout (no clearance
    // class, no placeholder pose).
    expect(main.match(/<AgentHeaderAvatar/g)).toHaveLength(1);
    expect(main).toContain('<main className="login">');
    expect(main).not.toContain('className="login has-avatar"');
  });

  it("gives the tab bar and the page the avatar clearance classes", () => {
    expect(main).toContain('<nav className="has-avatar">');
    expect(main).toContain('<main className="has-avatar">');
  });
});
