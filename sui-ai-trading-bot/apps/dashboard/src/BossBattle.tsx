import React, { useId, useRef, useState } from "react";
import {
  bossAppearance,
  bossDropText,
  bossPartyMembers,
  type BossBattleState,
} from "../../../packages/shared/src/boss.ts";
import { partyNames } from "../../../packages/shared/src/party.ts";
import lightning from "./assets/boss-lightning.webp";
import swamp from "./assets/boss-swamp.webp";
import hero from "./assets/hero-brave-blue.webp";
import forecast from "./assets/party-sakiyomi.webp";
import shield from "./assets/party-shield.webp";
import shadow from "./assets/party-kage.webp";
import healer from "./assets/party-healer.webp";

export interface HeroBattleStats {
  level: number;
  equity: number | null;
  hasPosition: boolean;
  unrealized: number | null;
}

const portraits = { lightning, swamp };
const partyIcons = { forecast, shield, shadow, healer };
const percentage = (fraction: number) => Math.round(fraction * 100);

function HpBar({ value, label }: { value: number | null; label: string }) {
  return (
    <span
      className="boss-hp"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : percentage(value)}
    >
      {value !== null && <span style={{ width: `${value * 100}%` }} />}
    </span>
  );
}

function turnText(boss: BossBattleState) {
  if (boss.turn === null) return "RSIの更新待ち";
  return boss.turn === "boss" ? "ボスのターン" : "こちらの攻撃";
}

export function BossBattleCard({
  boss,
  stats,
}: {
  boss: BossBattleState;
  stats: HeroBattleStats;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <div className="boss-battle">
      <button
        type="button"
        className="boss-card"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        ref={trigger}
        onClick={() => setOpen(!open)}
      >
        <img src={portraits[boss.type]} alt="" />
        <span className="boss-card-details">
          <strong>{boss.name}</strong>
          <HpBar value={boss.recovery} label="ボスの回復率" />
          <span>
            戻り {percentage(boss.recovery)}% ／ {turnText(boss)}
          </span>
        </span>
      </button>
      {open && (
        <section
          id={id}
          className="boss-sheet"
          aria-label="ボス戦"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <button type="button" className="boss-close" onClick={close}>
            閉じる
          </button>
          <BossBattle boss={boss} stats={stats} />
        </section>
      )}
    </div>
  );
}

export function BossBattle({
  boss,
  stats,
}: {
  boss: BossBattleState;
  stats: HeroBattleStats;
}) {
  const hp = !stats.hasPosition
    ? 1
    : stats.equity === null || boss.startingEquity <= 0
      ? null
      : Math.max(0, Math.min(1, stats.equity / boss.startingEquity));
  const pnl = stats.unrealized;
  const participants = bossPartyMembers.flatMap((member) => {
    const count = boss.partyActions?.[member] ?? 0;
    return count >= 1 ? [{ member, count }] : [];
  });
  const positionText = !stats.hasPosition
    ? "無傷（ポジションなし）"
    : pnl === null
      ? "含み損益 —"
      : `含み損益 ${pnl > 0 ? "+" : ""}${pnl.toFixed(2)} USDC`;
  return (
    <>
      <div className="boss-arena">
        <div className="boss-plate">
          <strong>{boss.name}</strong>
          <span>強さ {boss.strength}</span>
          <HpBar value={boss.recovery} label="ボスの回復率" />
          <span>戻り {percentage(boss.recovery)}%</span>
        </div>
        <img className="boss-portrait" src={portraits[boss.type]} alt="" />
        <img
          className="boss-portrait"
          src={hero}
          alt="剣と盾を持った青い雫の勇者"
        />
        <div className="boss-plate">
          <strong>ポタリオ</strong>
          <span>Lv. {stats.level}</span>
          <HpBar value={hp} label="ポタリオのHP" />
          <span>{positionText}</span>
        </div>
      </div>
      {participants.length > 0 && (
        <div className="boss-party">
          <strong>参戦</strong>
          <ul>
            {participants.map(({ member, count }) => (
              <li key={member}>
                <img src={partyIcons[member]} alt="" width={24} height={24} />
                <span>{partyNames[member]} ×{count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="boss-message">
        <strong>{bossAppearance(boss)}</strong>
        <p>
          {turnText(boss)} ／ {boss.latestEvent ?? bossDropText(boss)}
        </p>
      </div>
    </>
  );
}
