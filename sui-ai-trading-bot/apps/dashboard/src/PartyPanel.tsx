import { useEffect, useRef, useState } from "react";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import { partyNames } from "../../../packages/shared/src/party.ts";
import partyHeroIcon from "./assets/party-hero.webp";
import partySakiyomiIcon from "./assets/party-sakiyomi.webp";
import partyShieldIcon from "./assets/party-shield.webp";
import partyKageIcon from "./assets/party-kage.webp";
import partyHealerIcon from "./assets/party-healer.webp";
import partySageIcon from "./assets/party-sage.webp";

type State = BotSnapshot;

const BOSS_HISTORY_DISPLAY_LIMIT = 5;
const bossHistoryDate = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "2-digit",
  day: "2-digit",
});

const partyIcons = {
  hero: partyHeroIcon,
  forecast: partySakiyomiIcon,
  shield: partyShieldIcon,
  shadow: partyKageIcon,
  healer: partyHealerIcon,
  sage: partySageIcon,
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
  bossHistory = [],
  toggles,
  sageWork,
}: {
  party: State["party"] | undefined;
  bossHistory?: State["bossHistory"];
  toggles?: PartyToggles;
  sageWork?: State["sageWork"];
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
        {(["hero", "forecast", "shield", "shadow", "healer", "sage"] as const).map((member) => {
          const entry = party[member];
          if (!entry) return null;
          const key = TOGGLE_KEYS[member as keyof typeof TOGGLE_KEYS];
          const on = key && toggles ? toggles[key] : undefined;
          const inner = (
            <>
              <img className="overview-party-icon" src={partyIcons[member]} alt="" />
              <span>{member === "forecast" && <small>主人公の技 </small>}{partyNames[member]}{member === "sage" && <span className="party-sage-title">大賢者</span>}</span>
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
                        ? member === "sage"
                          ? sageWork
                            ? `毎朝の振り返り担当 ・ 直近30日の判断 ${sageWork.decisions30d.toLocaleString("ja-JP")}件`
                            : "毎朝の振り返り担当"
                          : member === "shadow" && entry.count != null
                            ? `累計 ${entry.count.toLocaleString("ja-JP")}件 ・ 最大レベル`
                            : "最大レベル"
                        : member === "shadow" && entry.count != null
                          ? `累計 ${entry.count.toLocaleString("ja-JP")}件 ・ 次のレベルまで あと${entry.remaining.toLocaleString("ja-JP")}件`
                          : `次のレベルまで あと${entry.remaining.toLocaleString("ja-JP")}件`}
              </small>
              {member === "sage" && sageWork && (
                <div className="party-sage-work">
                  <span className="party-sage-badge">
                    <span className="party-sage-dot" />
                    検証中
                  </span>
                  <p className="party-sage-work-title">{sageWork.verification.title}</p>
                  <div className="party-sage-chips">
                    {(
                      [
                        { label: "下降", count: sageWork.verification.down },
                        { label: "横ばい", count: sageWork.verification.range },
                      ] as const
                    ).map((chip) => (
                      <div className="party-sage-chip" key={chip.label}>
                        <div className="party-sage-chip-head">
                          <span>{chip.label}</span>
                          <span className="party-sage-pct">
                            {Math.min(
                              100,
                              Math.round(
                                (chip.count / sageWork.verification.target) * 100,
                              ),
                            )}
                            %
                          </span>
                        </div>
                        <progress
                          max={sageWork.verification.target}
                          value={Math.min(chip.count, sageWork.verification.target)}
                          aria-label={`${chip.label}の買い合図の検証進捗`}
                        />
                        <span className="party-sage-chip-count">
                          買い合図 {chip.count} / {sageWork.verification.target} 件
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          );
          return (
            <li
              key={member}
              className={
                member === "forecast"
                  ? "overview-party-skill"
                  : member === "sage"
                    ? "overview-party-sage"
                    : undefined
              }
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
      {bossHistory.length > 0 && (
        <section className="party-boss-history" aria-label="ボス戦の戦績">
          <h4>ボス戦の戦績</h4>
          <ul>
            {bossHistory.slice(0, BOSS_HISTORY_DISPLAY_LIMIT).map((battle) => (
              <li key={`${battle.startedAt}:${battle.endedAt}`}>
                <time dateTime={new Date(battle.endedAt).toISOString()}>
                  {bossHistoryDate.format(battle.endedAt)}
                </time>
                <span className="party-boss-history-name" title={battle.name}>
                  {battle.name}
                </span>
                <span>{battle.result === "endured" ? "耐え切った" : "撤退"}</span>
                <span>−{(battle.drop * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ul>
          {bossHistory.length > BOSS_HISTORY_DISPLAY_LIMIT && (
            <p className="overview-party-note">
              ほか{bossHistory.length - BOSS_HISTORY_DISPLAY_LIMIT}件
            </p>
          )}
        </section>
      )}
    </section>
  );
}
