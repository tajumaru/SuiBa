import { APP_BUILD, APP_SUBJECT, type ServedVersion } from "./appVersion.ts";

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

/** The running build's identity, always visible at the page
 * foot so a reflected deploy can be verified at a glance. */
export function VersionFooter() {
  return (
    <footer className="version-footer">
      SuiBa {APP_BUILD}
      {APP_SUBJECT ? ` ・ ${APP_SUBJECT}` : ""}
    </footer>
  );
}
