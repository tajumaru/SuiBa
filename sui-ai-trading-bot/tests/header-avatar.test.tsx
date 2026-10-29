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

  it("sticks a 76px circle to the top centre, half over the header at rest", () => {
    // The dock is sticky, not positioned against the header: its
    // containing block spans the whole page, so after the header
    // scrolls away it stays 9px below the viewport top. The
    // negative margins centre the resting dock on the header's
    // bottom edge (half over it), exactly where it used to float.
    // The dock is 112px tall (76px avatar + 8px pill margin +
    // ~28px pill), so each negative margin is half of that: 56px.
    expect(section).toContain(
      ".agent-avatar-dock {\n  position: sticky;\n  top: 9px;\n  z-index: 5;",
    );
    expect(section).toContain("width: fit-content;");
    expect(section).toContain("margin: -56px auto -56px;");
    expect(section).toContain("pointer-events: none;");
    expect(section).not.toContain("translate(-50%, 50%)");
    expect(section).toContain(
      ".agent-avatar {\n  position: relative;\n  width: 76px;\n  height: 76px;\n  border-radius: 50%;",
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
    // The pill's bottom edge rests 56px below the header's bottom
    // edge (half the 112px dock); the clearance adds the same
    // ~14px of breathing room the 92px avatar had: 56 + 14 = 70.
    // Desktop: the tab bar (rendered only while connected, like
    // the avatar) carries the clearance.
    expect(css).toContain("nav.has-avatar {\n  padding-top: 70px;\n}");
    // Mobile: the dock stays sticky and follows the scroll; the
    // clearance moves to the top of the page instead.
    expect(section).not.toContain(
      ".agent-avatar-dock {\n    position: relative;",
    );
    expect(section).not.toContain("margin: 16px auto 0;");
    expect(css).toContain("main.has-avatar {\n    padding-top: 70px;");
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
    // …while the explanatory footnote under the feed is gone.
    expect(html).not.toContain("agent-feed-note");
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
    expect(main).toContain("<AgentHeaderAvatar");
    expect(main).toContain("pose={agentPose}");
    expect(main).toContain("celebrating={buyCelebration}");
    expect(main).toContain("shout={shout}");
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

  it("keeps the header avatar dock behind the token", () => {
    // The dock's single render site is guarded by the token.
    // Before connecting, the login gate (LoginScreen) renders
    // instead: it carries its own gatekeeper artwork inside its
    // own main, which is a different element from the dock —
    // the dock itself still never appears pre-login, and the
    // login main takes no avatar clearance class.
    expect(main.match(/<AgentHeaderAvatar/g)).toHaveLength(1);
    expect(main).toContain("<LoginScreen");
    expect(main).not.toContain('className="login has-avatar"');
    const login = readFileSync(
      resolve("apps/dashboard/src/LoginScreen.tsx"),
      "utf8",
    );
    expect(login).not.toContain("AgentHeaderAvatar");
    expect(login).toContain("AgentAvatarArtwork");
  });

  it("gives the tab bar and the page the avatar clearance classes", () => {
    expect(main).toContain('<nav className="has-avatar">');
    expect(main).toContain('<main className="has-avatar">');
  });
});

describe("slim two-row header (design A)", () => {
  const main = readFileSync(resolve("apps/dashboard/src/main.tsx"), "utf8");
  const header = main.slice(
    main.indexOf("<header>"),
    main.indexOf("</header>"),
  );
  const rowMain = header.slice(
    header.indexOf("header-row-main"),
    header.indexOf("header-row-sub"),
  );
  const rowSub = header.slice(header.indexOf("header-row-sub"));
  const css = readFileSync(
    new URL("../apps/dashboard/src/style.css", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("puts the title and the PAPER badge on the top row", () => {
    expect(rowMain).toContain("<strong>◈ Sui Paper Lab</strong>");
    expect(rowMain).toContain('className="badge"');
    expect(rowMain).toContain("PAPER（仮想売買）専用");
    expect(rowMain).not.toContain("緊急停止");
    expect(rowMain).not.toContain("ログアウト");
  });

  it("keeps emergency stop and logout on the sub row without the subtitle", () => {
    expect(rowSub).toContain('className="danger"');
    expect(rowSub).toContain("緊急停止");
    expect(rowSub).not.toContain('className="header-meta"');
    expect(rowSub).toContain("ログアウト");
    expect(rowSub).toContain('className="logout-link"');
  });

  it("shows the pair as a segmented switch in the sub row, not in the subtitle", () => {
    // The selected pair is carried by the segmented switch (the
    // pressed button), so the subtitle no longer repeats it; the
    // redundant market subtitle is omitted from the header.
    expect(rowSub).toContain('className={`pair-switch');
    expect(rowSub).toContain('aria-label="取引ペア"');
    expect(rowSub).toContain('"SUI_USDC", "SUI"');
    expect(rowSub).toContain('"WAL_USDC", "WAL"');
    expect(rowSub).not.toContain("pair-selector");
    expect(header).not.toContain("<select");
    expect(rowSub).not.toContain("メインネットの市場データ");
    expect(header).not.toContain("メインネットの市場データ");
    expect(rowMain).not.toContain("メインネットの市場データ");
  });

  it("styles the header as two slim rows with a compact badge and stop pill", () => {
    expect(css).toContain(
      "header {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 10px 5% 12px;",
    );
    expect(css).toContain(
      ".header-row {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  min-width: 0;\n}",
    );
    // The sub row never wraps, so the header keeps one height on
    // every tab; the meta line ellipsises and the scrollbar gutter
    // is reserved so page length cannot change the layout width.
    expect(css).toContain(".header-row-sub {\n  flex-wrap: nowrap;\n}");
    expect(css).toContain("text-overflow: ellipsis;");
    expect(css).toContain("scrollbar-gutter: stable;");
    expect(css).toContain("header strong {\n  font-size: 16px;");
    expect(css).toContain(
      ".badge {\n  margin-left: auto;\n  border: 1px solid #41d9b0;\n  color: #41d9b0;\n  padding: 3px 9px;",
    );
    expect(css).toContain("font-size: 11px;");
    expect(css).toContain(
      "header .danger {\n  min-height: 36px;\n  padding: 6px 14px;\n  border-radius: 999px;\n  font-size: 12px;",
    );
    // The old three-band subtitle spacing is gone.
    expect(css).not.toContain("header small {");
  });

  it("keeps the dock geometry consistent with the 76px avatar", () => {
    // Dock height 112px = 76 (avatar) + 8 (pill margin) + ~28
    // (pill): negative margins are half the dock (56px) and the
    // clearance is the below-edge half plus ~14px of air (70px).
    const section = css.slice(
      css.indexOf("/* Agent header avatar:"),
      css.indexOf("/* Agent narration feed:"),
    );
    expect(section).toContain("margin: -56px auto -56px;");
    expect(css).toContain("nav.has-avatar {\n  padding-top: 70px;\n}");
  });
});
