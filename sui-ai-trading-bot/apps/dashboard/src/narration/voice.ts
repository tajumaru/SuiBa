/**
 * The speaking character's voice, laid over the narration's
 * stock phrasing. The white character speaks the templates as
 * written; ぺんちゃん ends her lines …ぺん and King Fizh speaks
 * like a king (…であるぞ). Exactly one marker per entry — the
 * first spoken ending — so the voice reads as a flavour, not a
 * dub over every clause, and every number and fact stays as
 * recorded.
 *
 * Kinds that carry their own designed voice are never touched:
 * the Kansai-ben emotion leaks (nearMiss / watchHit), sleep
 * talk, the monthly report card, epoch marks, and the chat
 * kinds (the user's own words, and the chat replies, which are
 * generated — and voiced — by agentChat itself).
 */

import type { AgentCharacter } from "../agentCharacter.ts";
import { agentDisplayName } from "../agentName.ts";
import type { NarrationKind } from "./state.ts";

const UNVOICED_KINDS: ReadonlySet<NarrationKind> = new Set([
  "chatUser",
  "chatReply",
  "chatPrompt",
  "nearMiss",
  "watchHit",
  "sleepTalk",
  "monthlyReport",
  "epoch",
]);

const PEN_ENDINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/したよ/, "したぺん"],
  [/するよ/, "するぺん"],
  [/ないよ/, "ないぺん"],
  [/だよ/, "だぺん"],
  [/だね/, "だぺん"],
  [/ね(?=。|$)/, "ぺん"],
  // Any other verb-final よ (見送ったよ, 待つよ, …): the
  // specific endings above start earlier in the text and win.
  [/よ(?=。|：|！|!|$)/, "ぺん"],
];

const FIZH_ENDINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/したよ/, "したぞ"],
  [/するよ/, "するぞ"],
  [/ないよ/, "ないぞ"],
  [/だよ/, "であるぞ"],
  [/だね/, "じゃな"],
  [/よ(?=。|：|！|!|$)/, "ぞ"],
];

/**
 * The handover line when the speaking character is switched:
 * the incoming character thanks the outgoing one by name and
 * takes over, in their own voice. When a custom name makes
 * both sides read the same, the address is dropped and the
 * takeover stands alone.
 */
export function greetingText(
  prev: AgentCharacter,
  next: AgentCharacter,
  name: string,
): string {
  const prevName = agentDisplayName(name, prev);
  const nextName = agentDisplayName(name, next);
  const addressed = prevName !== nextName;
  switch (next) {
    case "pen":
      return (
        (addressed ? `${prevName}、おつかれさまだぺん。` : "") +
        `交代だぺん！ここからは${nextName}が実況するぺん`
      );
    case "fizh":
      return (
        (addressed ? `${prevName}、ご苦労であった。` : "") +
        `交代であるぞ。ここからは余、${nextName}が実況するぞ`
      );
    default:
      return (
        (addressed ? `${prevName}、おつかれさま。` : "") +
        `交代だよ。ここからは${nextName}が実況するよ`
      );
  }
}

/** Rewrite the first spoken ending of `text` in the
 * character's voice. White (and unvoiced kinds, and texts with
 * no spoken ending) pass through unchanged. */
export function voiceText(
  kind: NarrationKind,
  text: string,
  character: AgentCharacter,
): string {
  if (character === "white" || UNVOICED_KINDS.has(kind)) return text;
  const endings = character === "pen" ? PEN_ENDINGS : FIZH_ENDINGS;
  let best: { index: number; length: number; replacement: string } | null =
    null;
  for (const [pattern, replacement] of endings) {
    const match = pattern.exec(text);
    if (match && (best === null || match.index < best.index)) {
      best = {
        index: match.index,
        length: match[0].length,
        replacement,
      };
    }
  }
  if (!best) return text;
  return (
    text.slice(0, best.index) +
    best.replacement +
    text.slice(best.index + best.length)
  );
}
