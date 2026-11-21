import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppHeader } from "../apps/dashboard/src/AppHeader.tsx";

// token="" keeps the avatar dock out of the render, so these
// assertions cover exactly the header markup.
const header = (data: { mode: string; network?: string }) =>
  renderToStaticMarkup(
    <AppHeader
      data={data as never}
      token=""
      control={async () => null}
      logout={() => {}}
      agentPose="normal"
      pointSmileCause={null}
      buyCelebration={false}
      shout={null}
      agentName="シロ"
      changeAgentName={() => {}}
      voiceListening={false}
      agentSpeaking={false}
    />,
  );

describe("network badge", () => {
  it("is hidden in PAPER even on mainnet (data source is not trading)", () => {
    const html = header({ mode: "PAPER", network: "mainnet" });
    expect(html).toContain("PAPER（仮想売買）専用");
    expect(html).not.toContain("MAINNET");
  });

  it("is hidden in PAPER on testnet too, with no amber tint", () => {
    const html = header({ mode: "PAPER", network: "testnet" });
    expect(html).not.toContain("TESTNET");
    expect(html).not.toContain("header-testnet");
  });

  it("shows in REAL, with the amber tint only on testnet", () => {
    const testnet = header({ mode: "REAL", network: "testnet" });
    expect(testnet).toContain("TESTNET");
    expect(testnet).toContain("header-testnet");
    const mainnet = header({ mode: "REAL", network: "mainnet" });
    expect(mainnet).toContain("MAINNET");
    expect(mainnet).not.toContain("header-testnet");
  });
});
