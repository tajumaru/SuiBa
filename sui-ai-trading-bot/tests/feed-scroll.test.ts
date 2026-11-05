import { describe, expect, it } from "vitest";
import {
  FEED_STICK_THRESHOLD_PX,
  feedJumpVisible,
  isStuckToFeedBottom,
  pageBottomDistance,
} from "../apps/dashboard/src/feedScroll.ts";

describe("feed scroll: distance to the page bottom", () => {
  it("is 0 when fully scrolled down", () => {
    expect(
      pageBottomDistance({
        scrollHeight: 2000,
        scrollY: 1200,
        viewportHeight: 800,
      }),
    ).toBe(0);
  });

  it("measures the unscrolled remainder", () => {
    expect(
      pageBottomDistance({
        scrollHeight: 2000,
        scrollY: 300,
        viewportHeight: 800,
      }),
    ).toBe(900);
  });

  it("never goes negative when the page is shorter than the viewport", () => {
    expect(
      pageBottomDistance({
        scrollHeight: 500,
        scrollY: 0,
        viewportHeight: 800,
      }),
    ).toBe(0);
  });
});

describe("feed scroll: the stick decision", () => {
  it("sticks at the bottom and within the threshold", () => {
    expect(isStuckToFeedBottom(0)).toBe(true);
    expect(isStuckToFeedBottom(FEED_STICK_THRESHOLD_PX)).toBe(true);
  });

  it("releases once the reader is past the threshold into history", () => {
    expect(isStuckToFeedBottom(FEED_STICK_THRESHOLD_PX + 1)).toBe(false);
    expect(isStuckToFeedBottom(5000)).toBe(false);
  });

  it("honours a custom threshold", () => {
    expect(isStuckToFeedBottom(50, 40)).toBe(false);
    expect(isStuckToFeedBottom(50, 60)).toBe(true);
  });
});

describe("feed scroll: the jump pill's visibility", () => {
  it("shows while the reader is away from the bottom with entries below", () => {
    expect(feedJumpVisible(900, 12)).toBe(true);
  });

  it("hides at the bottom — there is nothing to jump to", () => {
    expect(feedJumpVisible(0, 12)).toBe(false);
    expect(feedJumpVisible(FEED_STICK_THRESHOLD_PX, 12)).toBe(false);
  });

  it("hides while the feed is still empty, however far away", () => {
    expect(feedJumpVisible(900, 0)).toBe(false);
  });
});
