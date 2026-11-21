import { useEffect, useRef, useState } from "react";
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
 * Live switches behind two party members: まもりの盾 is the
 * ProfitGuard setting and かげの声 is the shadow setting. The
 * strategy tab passes this in; without it the panel is a plain
 * readout (previews, tests).
 */
export type PartyToggles = {
  profitGuardEnabled: boolean;
  shadowEnabled: boolean;
  disabled?: boolean;
  onToggle: (
    key: "profitGuardEnabled" | "shadowEnabled",
    next: boolean,
  ) => Promise<void>;
};

const TOGGLE_KEYS = {
  shield: "profitGuardEnabled",
  shadow: "shadowEnabled",
} as const;

/**
 * The RPG party panel: the hero and its skills with their levels.
 * It lives in the strategy tab's パーティ segment (moved from the
 * overview tab on 2026-11-21, owner call: that is where it gets
 * looked at, next to さくせん and 設定). Tapping まもりの盾 or
 * かげの声 toggles the real setting behind it; turning the shield
 * OFF takes a confirming second tap, and an OFF member greys out.
 */
export function Party({
  party,
  toggles,
}: {
  party: State["party"] | undefined;
  toggles?: PartyToggles;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (!party || !party.hero) return null;

  const handleTap = async (
    key: "profitGuardEnabled" | "shadowEnabled",
    on: boolean,
  ) => {
    if (!toggles || toggles.disabled || busy) return;
    // The shield guards real sells: OFF needs a second tap.
    if (key === "profitGuardEnabled" && on && !armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    setBusy(true);
    setFailed(false);
    try {
      await toggles.onToggle(key, !on);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="overview-party" aria-label="パーティ">
      <h3>パーティ</h3>
      <ul>
        {(["hero", "forecast", "shield", "shadow"] as const).map((member) => {
          const entry = party[member];
          if (!entry) return null;
          const key = TOGGLE_KEYS[member as keyof typeof TOGGLE_KEYS];
          const on = key && toggles ? toggles[key] : undefined;
          const inner = (
            <>
              <img className="overview-party-icon" src={partyIcons[member]} alt="" />
              <span>{member === "forecast" && <small>主人公の技 </small>}{partyNames[member]}</span>
              <strong>{on === false ? "OFF" : `Lv.${entry.level}`}</strong>
              <progress max={1} value={entry.progress} aria-label={`${partyNames[member]}の経験値`} />
              <small>
                {failed && key
                  ? "保存できませんでした"
                  : key === "profitGuardEnabled" && on && armed
                    ? "もう一度タップでOFFにします"
                    : on === false
                      ? "OFF（タップでON）"
                      : entry.remaining === null
                        ? "最大レベル"
                        : `次のレベルまで あと${entry.remaining.toLocaleString("ja-JP")}件`}
              </small>
            </>
          );
          return (
            <li
              key={member}
              className={member === "forecast" ? "overview-party-skill" : undefined}
              data-off={on === false || undefined}
            >
              {key && toggles ? (
                <button
                  type="button"
                  className="overview-party-toggle"
                  aria-pressed={on}
                  aria-label={`${partyNames[member]}を${on ? "OFF" : "ON"}にする`}
                  disabled={toggles.disabled || busy}
                  onClick={() => void handleTap(key, on!)}
                >
                  {inner}
                </button>
              ) : (
                inner
              )}
            </li>
          );
        })}
      </ul>
      {toggles?.disabled && (
        <p className="overview-party-note">
          設定に未保存の変更があるため、保存すると切り替えできます
        </p>
      )}
    </section>
  );
}
