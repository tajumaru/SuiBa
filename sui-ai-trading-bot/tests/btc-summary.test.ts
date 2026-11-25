import { describe, expect, it } from "vitest";
import { parseBtcShadowSummary } from "../apps/dashboard/src/btcSummary.ts";

const at = "2026-11-25T10:43:21.757Z";
const body = "XBTC_USDC: 判断49件（AI買い1件）。+4h採点0件（AI買い分0件、平均―、プラス率―）。最新：AI=WAIT（確信64%）ルール=WAIT 局面=down 価格=58945。売買はしない記録だけの影。";
const episode = `[btc-shadow-summary] ${at} ${body}`;
const summary = `${episode} 動き: price=58943 chg24=-1.37 hi=60251 lo=58727 pts=59668,59775,60199,60085,60251,59757,59375,59946,60072,59673,59455,59821,59984,59735,59543,59260,59097,59387,58982,58953,59117,58727,59201,58840,58943`;

describe("parseBtcShadowSummary", () => {
  it("parses the episode and its 25 hourly closes", () => {
    expect(parseBtcShadowSummary(summary)).toEqual({
      at, body,
      move: {
        price: 58943, chg24: -1.37, hi: 60251, lo: 58727,
        pts: [
          59668, 59775, 60199, 60085, 60251, 59757, 59375, 59946, 60072,
          59673, 59455, 59821, 59984, 59735, 59543, 59260, 59097, 59387,
          58982, 58953, 59117, 58727, 59201, 58840, 58943,
        ],
      },
    });
  });

  it.each([
    ["no movement section", episode],
    ["malformed movement", summary.replace("chg24=-1.37", "chg24=unknown")],
    ["only one point", summary.replace(/pts=.*/, "pts=58943")],
  ])("keeps the body with %s", (_, text) => {
    expect(parseBtcShadowSummary(text)).toEqual({ at, body, move: null });
  });
});
