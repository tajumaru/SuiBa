import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentAvatarArtwork,
  ArtworkImage,
  artworkRetrySrc,
} from "../apps/dashboard/src/AgentHeaderAvatar.tsx";

describe("artworkRetrySrc", () => {
  it("appends the retry marker as a query", () => {
    expect(artworkRetrySrc("/assets/agent-white-sleep-abc.webp")).toBe(
      "/assets/agent-white-sleep-abc.webp?avatar-retry=1",
    );
  });

  it("joins with & when the URL already has a query", () => {
    expect(artworkRetrySrc("/assets/x.webp?v=2")).toBe(
      "/assets/x.webp?v=2&avatar-retry=1",
    );
  });
});

describe("ArtworkImage", () => {
  it("renders the plain src first (no retry marker)", () => {
    const html = renderToStaticMarkup(
      <ArtworkImage src="/assets/test.webp" />,
    );
    expect(html).toContain('src="/assets/test.webp"');
    expect(html).not.toContain("avatar-retry");
  });

  it("keeps the caller's class on the img", () => {
    const html = renderToStaticMarkup(
      <ArtworkImage className="agent-avatar-typing" src="/assets/t.webp" />,
    );
    expect(html).toContain('class="agent-avatar-typing"');
  });
});

describe("AgentAvatarArtwork", () => {
  it("renders an img for the pose artwork", () => {
    const html = renderToStaticMarkup(<AgentAvatarArtwork pose="sleep" />);
    expect(html).toContain("<img");
    expect(html).not.toContain("avatar-retry");
  });
});

describe("avatar placeholder style", () => {
  it("narration.css styles the missing-artwork placeholder", () => {
    const css = readFileSync(
      new URL(
        "../apps/dashboard/src/styles/narration.css",
        import.meta.url,
      ),
      "utf8",
    );
    expect(css).toContain(".agent-avatar-missing");
  });
});
