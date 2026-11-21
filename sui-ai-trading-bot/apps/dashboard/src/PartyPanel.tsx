import type { BotSnapshot } from "../../worker/src/engine.ts";
import { partyNames } from "../../../packages/shared/src/party.ts";
import partyHeroIcon from "./assets/party-hero.webp";
import partySakiyomiIcon from "./assets/party-sakiyomi.webp";
import partyShieldIcon from "./assets/party-shield.webp";
import partyKageIcon from "./assets/party-kage.webp";

type State = BotSnapshot;

const partyIcons = {
  hero: partyHeroIcon,
  forecast: partySakiyomiIcon,
  shield: partyShieldIcon,
  shadow: partyKageIcon,
} as const;

/**
 * The RPG party panel: the hero and its skills with their levels.
 * It lives in the strategy tab's パーティ segment (moved from the
 * overview tab on 2026-11-21, owner call: that is where it gets
 * looked at, next to さくせん and 設定).
 */
export function Party({ party }: { party: State["party"] | undefined }) {
  if (!party || !party.hero) return null;
  return (
    <section className="overview-party" aria-label="パーティ">
      <h3>パーティ</h3>
      <ul>
        {(["hero", "forecast", "shield", "shadow"] as const).map((member) => {
          const entry = party[member];
          if (!entry) return null;
          return (
            <li key={member} className={member === "forecast" ? "overview-party-skill" : undefined}>
              <img className="overview-party-icon" src={partyIcons[member]} alt="" />
              <span>{member === "forecast" && <small>主人公の技 </small>}{partyNames[member]}</span>
              <strong>Lv.{entry.level}</strong>
              <progress max={1} value={entry.progress} aria-label={`${partyNames[member]}の経験値`} />
              <small>{entry.remaining === null ? "最大レベル" : `次のレベルまで あと${entry.remaining.toLocaleString("ja-JP")}件`}</small>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
