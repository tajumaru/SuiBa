import { useEffect, useRef, useState, type RefObject } from "react";
import type { NarrationEntry, NarrationState } from "./agentNarration.ts";
import {
  feedJumpVisible,
  isStuckToFeedBottom,
  pageBottomDistance,
} from "./feedScroll.ts";

/**
 * Message-order scroll management for the narration feed,
 * extracted from AgentNarrationFeed: stick-to-bottom tracking,
 * the landing scroll, and the jump pill's visibility (the pill
 * itself renders in the feed). The entries render oldest
 * first, so following the feed means sitting at the page
 * bottom: while the reader is there, new entries pull the page
 * down with them; while they are up in the history, nothing
 * moves. Opening the tab lands at the latest entry, like
 * opening a chat. The pure stick / jump decisions live in
 * feedScroll.ts; this hook owns the listeners, the refs and
 * the scrolling itself.
 */
export function useFeedScroll({
  active,
  entries,
  narrationRef,
}: {
  /** Whether the narration tab is the one on screen. */
  active: boolean;
  /** The feed's entries, oldest first (render order). */
  entries: readonly NarrationEntry[];
  /** The state the next advance builds on; the listeners read
   * its entry count for the freshest jump decision. */
  narrationRef: RefObject<NarrationState>;
}) {
  const stickRef = useRef(true);
  // The reader's own sends always land at the bottom, even when
  // they had scrolled up to read history first — their message
  // and its reply would otherwise arrive out of sight.
  const forceStickRef = useRef(false);
  const landedRef = useRef(false);
  const [jumpVisible, setJumpVisible] = useState(false);
  const measureBottomDistance = () =>
    pageBottomDistance({
      scrollHeight: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight,
    });
  const scrollToLatest = (behavior: ScrollBehavior) => {
    stickRef.current = true;
    setJumpVisible(false);
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior,
    });
  };
  /** Mark the next entry change as the reader's own doing:
   * their sends land at the bottom even when they had scrolled
   * up into the history first. */
  const forceStick = () => {
    forceStickRef.current = true;
  };
  // Leaving the tab re-arms the landing: coming back to the feed
  // is opening the chat again.
  useEffect(() => {
    if (!active) landedRef.current = false;
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const update = () => {
      const distance = measureBottomDistance();
      stickRef.current = isStuckToFeedBottom(distance);
      setJumpVisible(
        feedJumpVisible(distance, narrationRef.current.entries.length),
      );
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);
  const newestEntryId = entries.at(-1)?.id ?? null;
  useEffect(() => {
    if (!active) return;
    if (!landedRef.current) {
      // First entries of this visit: land on the latest entry
      // without animation. (While the list is still empty there
      // is nothing to land on; the arrival re-runs this effect.)
      if (entries.length === 0) return;
      landedRef.current = true;
      scrollToLatest("auto");
      return;
    }
    if (forceStickRef.current || stickRef.current) scrollToLatest("auto");
    forceStickRef.current = false;
    setJumpVisible(
      feedJumpVisible(
        measureBottomDistance(),
        narrationRef.current.entries.length,
      ),
    );
  }, [active, newestEntryId, entries.length]);  return { jumpVisible, scrollToLatest, forceStick };
}
