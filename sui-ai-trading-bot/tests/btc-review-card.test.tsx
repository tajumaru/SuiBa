import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BtcReviewCard } from "../apps/dashboard/src/BtcPanel.tsx";

const at = "2026-11-25T10:43:21.757Z";
const body = "XBTC_USDC: 判断49件（AI買い1件）。+4h採点0件（AI買い分0件、平均―、プラス率―）。最新：AI=WAIT（確信64%）ルール=WAIT 局面=down 価格=58945。売買はしない記録だけの影。";
const text = `[btc-shadow-summary] ${at} ${body} 動き: price=58943 chg24=-1.37 hi=60251 lo=58727 pts=59668,58943`;

describe("BtcReviewCard", () => {
  it("shows the shadow grading as the BTC look-back", () => {
    const html = renderToStaticMarkup(
      createElement(BtcReviewCard, { summary: { text } }),
    );
    expect(html).toContain("BTCの影 ふりかえり");
    expect(html).toContain("判断49件");
    expect(html).toContain("+4h採点0件");
    expect(html).toContain("売買はしない記録だけの影");
    // The price-movement tail belongs to the ticker panel, not the look-back.
    expect(html).not.toContain("59668");
  });

  it("shows the waiting note while no record has arrived", () => {
    const html = renderToStaticMarkup(
      createElement(BtcReviewCard, { summary: null }),
    );
    expect(html).toContain("BTCの影の記録はまだ届いていません");
  });
});
