import type { ServedVersion } from "./appVersion.ts";

/** Shown when the server is already serving a newer build than
 * the page in hand: the one tap reload lands on the new build. */
export function UpdateBanner({ served }: { served: ServedVersion }) {
  return (
    <div className="update-banner" role="status">
      <span>
        新しい版（{served.build}）があります
        {served.subject ? `： ${served.subject}` : ""}
      </span>
      <button type="button" onClick={() => window.location.reload()}>
        再読み込み
      </button>
    </div>
  );
}

/** The page foot carries only the Sui credit. The build stamps
 * that used to sit next to it read "dev"/"unknown" in practice
 * and carried no information, so the owner removed them
 * (2026-11-20); build identity still travels in the diagnostic
 * export, and the update banner above still names the new build
 * when one is served. */
export function VersionFooter() {
  return (
    <footer className="version-footer">
      {/* The Sui credit lives here since 2026-11-19: the chain
          strip was slimmed to two numbers, and the owner still
          wanted the Sui mark somewhere on the page. */}
      <a
        className="version-footer-sui"
        href="https://sui.io"
        target="_blank"
        rel="noreferrer"
        aria-label="Sui"
      >
        <img src="/sui-logo.svg" alt="Sui" />
        <span>Built on Sui</span>
      </a>
    </footer>
  );
}
