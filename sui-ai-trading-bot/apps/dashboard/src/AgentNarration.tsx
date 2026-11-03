/* Split into per-area modules: the header avatar (AgentHeaderAvatar.tsx),
   the feed entry row (AgentFeedEntryRow.tsx), the feed itself
   (AgentNarrationFeed.tsx) and the shared reduced-motion hook
   (usePrefersReducedMotion.ts). This file is only the public surface:
   it re-exports exactly what the former single module exported, so
   import sites are unchanged. */
export { usePrefersReducedMotion } from "./usePrefersReducedMotion.ts";
export { AgentAvatarArtwork, AgentHeaderAvatar } from "./AgentHeaderAvatar.tsx";
export { AgentFeedEntryRow } from "./AgentFeedEntryRow.tsx";
export { AgentNarrationFeed } from "./AgentNarrationFeed.tsx";
