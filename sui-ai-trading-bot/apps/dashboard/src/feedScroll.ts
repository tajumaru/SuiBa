/**
 * Scroll decisions for the narration feed's message order
 * (oldest at the top, newest at the bottom, like a chat app).
 *
 * The feed flows with the page — there is no inner scroll box —
 * so "the bottom" is the bottom of the document: on its tab the
 * feed section is the last content, and its bottom margin is
 * sized to clear the fixed chat composer, which is exactly the
 * slack the reader needs at full scroll. These helpers stay
 * pure (metrics in, decision out) so the stick / jump rules are
 * testable without a DOM.
 */

/** How close to the page bottom (px) still counts as "at the
 * latest entry". Generous enough to absorb the version footer
 * under the feed and small layout drift; small enough that a
 * reader who scrolled up into the history is never treated as
 * following along. */
export const FEED_STICK_THRESHOLD_PX = 160;

export interface PageScrollMetrics {
  scrollHeight: number;
  scrollY: number;
  viewportHeight: number;
}

/** Distance in px from the current scroll position to the page
 * bottom; 0 when fully scrolled down (never negative). */
export function pageBottomDistance(m: PageScrollMetrics): number {
  return Math.max(0, m.scrollHeight - (m.scrollY + m.viewportHeight));
}

/** The reader is following the latest entries: new arrivals may
 * pull the page to the bottom with them. */
export function isStuckToFeedBottom(
  distancePx: number,
  thresholdPx: number = FEED_STICK_THRESHOLD_PX,
): boolean {
  return distancePx <= thresholdPx;
}

/** The "最新の実況へ" jump shows only while the reader is away
 * from the bottom and there are entries below to jump to. */
export function feedJumpVisible(
  distancePx: number,
  entryCount: number,
  thresholdPx: number = FEED_STICK_THRESHOLD_PX,
): boolean {
  return entryCount > 0 && !isStuckToFeedBottom(distancePx, thresholdPx);
}
