import {
  APP_BUILD,
  APP_SUBJECT,
  versionSkew,
  type ServedVersion,
} from "./appVersion.ts";

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

/** The running builds' identity, always visible at the page
 * foot: the screen's build next to the bot's, so a reflected
 * deploy — or a skew between the two — can be verified at a
 * glance. */
export function VersionFooter({
  workerBuild,
}: {
  workerBuild?: string | null;
}) {
  return (
    <footer className="version-footer">
      Potario 画面 {APP_BUILD}
      {workerBuild ? ` ・ Bot ${workerBuild}` : ""}
      {APP_SUBJECT ? ` ・ ${APP_SUBJECT}` : ""}
      {versionSkew(APP_BUILD, workerBuild) && (
        <span className="version-skew"> ・ 版がズレています</span>
      )}
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
