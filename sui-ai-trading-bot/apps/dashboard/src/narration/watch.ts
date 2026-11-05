import type { DecisionTelemetry } from "../../../worker/src/operations.ts";
import type { DecisionTrail, EntryCondKey, EntryConditionChip, EntryDraft, NarrationKind, NarrationState, WatchDisplay, WatchKindStats, WatchScoreDisplay, WatchTarget } from "./state.ts";
import { emaGapPct, entryConditions, macdWord, metEntryConditions, rsiPoints, unmetDistance, watchDistance, watchRatio } from "./decision.ts";
import { number as fmtNumber, percent as fmtPercent } from "../presentation.ts";
import { freshDecision } from "./state.ts";
import type { VitalState } from "../botVital.ts";

/** The approach call-out fires once, at half the declared distance. */
export const WATCH_APPROACH_RATIO = 0.5;
/**
 * Withdrawal hysteresis: the watched condition must drift beyond
 * 125% of its declared distance before the declaration is dropped,
 * so small wobbles never flap declare/withdraw back and forth.
 */
export const WATCH_WITHDRAW_RATIO = 1.25;

/**
 * Review milestone: a ふりかえり look-back is told once this many
 * watch settlements have piled up since the previous review — or
 * sooner, when a BUY closes a chapter (see REVIEW_BUY_MIN_SETTLED).
 * Settlements are never reviewed one by one.
 */
export const REVIEW_SETTLED_THRESHOLD = 3;
/** A BUY milestone reviews early only with at least this many
 * settlements still unreviewed. */
export const REVIEW_BUY_MIN_SETTLED = 2;

/**
 * The closest unmet entry condition, by the same normalised
 * `unmetDistance` the cycle narration already uses to pick what to
 * talk about — the watch invents no ruler of its own. Ties keep the
 * display order (EMA, RSI, MACD). `exclude` bars instantly
 * re-declaring a target that was just withdrawn.
 */
export function chooseWatchTarget(
  dec: DecisionTelemetry,
  exclude?: EntryCondKey,
): EntryCondKey | null {
  const unmet = entryConditions(dec).filter((c) => !c.met && c.key !== exclude);
  if (!unmet.length) return null;
  return unmet.reduce((a, b) =>
    unmetDistance(dec, b.key) < unmetDistance(dec, a.key) ? b : a,
  ).key;
}

export function makeWatch(key: EntryCondKey, dec: DecisionTelemetry): WatchTarget {
  const declaredDistance = watchDistance(key, dec);
  return {
    key,
    declaredDistance,
    called: false,
    closestDistance: declaredDistance,
  };
}

/** A watch only lives while the bot is flat and still hunting. */
export function watchEligible(dec: DecisionTelemetry): boolean {
  return (
    dec.action === "WAIT" &&
    !dec.conditions.hasPosition &&
    metEntryConditions(dec) < 3
  );
}

export const WATCH_NAME: Record<EntryCondKey, string> = {
  emaUp: "EMAの差",
  rsiRecovery: "RSI",
  histogramImproving: "MACD",
};

/** Current-value phrase for a watch target ("今-0.38%", "今29で圏内"…). */
export function watchValue(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp") return `今${emaGapPct(dec)}`;
  if (key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? `今${fmtNumber(dec.rsi, 1)}で圏内`
      : `今${fmtNumber(dec.rsi, 1)}、ラインまで${rsiPoints(dec.rsi, dec.oversold)}`;
  return `今${macdWord(dec)}`;
}

export function declareWatchText(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp")
    return `次はEMAの差を見てる。今${emaGapPct(dec)}、縮んできたら声かけるね`;
  if (key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? `次はRSIを見てる。今${fmtNumber(dec.rsi, 1)}で圏内、上抜けたら声かけるね`
      : `次はRSIを見てる。今${fmtNumber(dec.rsi, 1)}、ラインまで${rsiPoints(dec.rsi, dec.oversold)}。近づいたら声かけるね`;
  return `次はMACDを見てる。今${macdWord(dec)}、プラスに転じたら声かけるね`;
}

export function approachWatchText(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp")
    return `EMAの差、${emaGapPct(dec)}まで縮んだ。宣言してたやつ、来てるよ`;
  if (key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? "RSI、圏内まで来たよ。宣言してたやつ、上抜け待ちだね"
      : `RSI、ラインまで${rsiPoints(dec.rsi, dec.oversold)}まで来た。宣言してたやつ、来てるよ`;
  return macdWord(dec) === "ほぼゼロ"
    ? `MACD、ゼロ手前まで戻った。宣言してたやつ、来てるよ`
    : `MACD、戻ってきた。宣言してたやつ、来てるよ`;
}

/**
 * The hit line: the recorded facts stay exactly as measured, and
 * the close turns smug — the Kansai catchphrase 「ほらな、言うてた
 * やろ」, the counterpart of the near-miss line's dialect slip.
 */
export function hitWatchText(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp")
    return dec.conditions.emaGapShrinking
      ? `EMA、成立した。${fmtNumber(dec.ema20, 4)}はまだ${fmtNumber(dec.ema50, 4)}の下、差の縮小が続いての成立。ほらな、言うてたやろ`
      : `EMA、成立した。${fmtNumber(dec.ema20, 4)}が${fmtNumber(dec.ema50, 4)}の上。ほらな、言うてたやろ`;
  if (key === "rsiRecovery")
    return `RSI、上抜けた。${fmtNumber(dec.previousRsi, 1)}→${fmtNumber(dec.rsi, 1)}。ほらな、言うてたやろ`;
  return `MACD、成立した。今${macdWord(dec)}。ほらな、言うてたやろ`;
}

export function withdrawWatchText(key: EntryCondKey): string {
  if (key === "emaUp")
    return "注目してたEMAの差、開いてきたなあ。宣言は取り下げ";
  if (key === "rsiRecovery")
    return "注目してたRSI、遠のいたなあ。宣言は取り下げ";
  return "注目してたMACD、遠のいたなあ。宣言は取り下げ";
}

/**
 * The near-miss line for a called watch that slipped away, naming
 * the closest distance reached while watching (converted back to
 * each condition's own scale). This is the one line told in Kansai
 * dialect — the disappointment leaks out of the usual voice.
 */
export function nearMissText(key: EntryCondKey, closestDistance: number): string {
  if (key === "emaUp")
    return `EMAの差、${fmtPercent(-closestDistance)}まで詰めてたのに、また開いてきたわ…`;
  if (key === "rsiRecovery")
    return `RSI、あと${Math.max(0, Math.round(closestDistance))}まで来てたのに…なんで離れるねん`;
  return `MACD、ゼロ手前まで戻してたのに、また下がってもうたわ…`;
}

export interface WatchOutcome {
  /** Drafts told before the cycle's own narration (declare / call /
   * hit / withdraw / switch). */
  before: EntryDraft[];
  /** Drafts told after it (the next declaration following a hit). */
  after: EntryDraft[];
  watch: WatchTarget | null;
  /** A new watch was declared this cycle (scores one declaration). */
  created: boolean;
  /** How the previous watch settled this cycle, if it did: "hit"
   * when the watched condition clicked while watched, "miss" when
   * it was withdrawn for drifting away. A watch that ends silently
   * (position opened, material gone) settles as null — neither. */
  settled: "hit" | "miss" | null;
  /** Set when this cycle TOLD a near miss: its key and the closest
   * distance reached, kept as the sleep talk's material. */
  nearMiss: { key: EntryCondKey; closestDistance: number } | null;
}

/**
 * Advance the declared watch by one narrated cycle. The caller has
 * already established that the decision is fresh, the bot is awake,
 * and the watch may live (see watchEligible for when it silently
 * ends instead: a fill, a position, or all conditions met are told
 * by their own narration, so the watch never talks over them).
 */
export function processWatch(
  current: WatchTarget | null,
  dec: DecisionTelemetry,
): WatchOutcome {
  const draft = (text: string, kind: NarrationKind = "cycle"): EntryDraft => ({
    at: dec.evaluatedAt,
    kind,
    text,
  });
  if (!watchEligible(dec))
    // The watch ends here. If the watched condition clicked in this
    // very decision — the last condition falling into place for a
    // BUY, or all three met — that still counts as a hit; any other
    // silent end (a position opened, the hunt is over) is neither a
    // hit nor a miss.
    return {
      before: [],
      after: [],
      watch: null,
      created: false,
      settled: current && dec.conditions[current.key] ? "hit" : null,
      nearMiss: null,
    };

  if (current && dec.conditions[current.key]) {
    // 的中: tie the click back to the declaration, then declare the
    // next watch right away (told after the cycle's own line).
    const next = chooseWatchTarget(dec);
    return {
      before: [draft(hitWatchText(current.key, dec), "watchHit")],
      after: next
        ? [
            draft(
              `次の注目は${WATCH_NAME[next]}に決めた。${watchValue(next, dec)}だよ`,
            ),
          ]
        : [],
      watch: next ? makeWatch(next, dec) : null,
      created: next != null,
      settled: "hit",
      nearMiss: null,
    };
  }

  if (current) {
    const ratio = watchRatio(current, dec);
    const closest = Math.min(
      current.closestDistance,
      watchDistance(current.key, dec),
    );
    if (ratio > WATCH_WITHDRAW_RATIO) {
      // A watch that had its approach called really did come close:
      // its withdrawal is told as a near miss, naming how close it
      // got. One that never came close keeps the plain withdrawal.
      const before = [
        current.called
          ? draft(nearMissText(current.key, closest), "nearMiss")
          : draft(withdrawWatchText(current.key)),
      ];
      const next = chooseWatchTarget(dec, current.key);
      if (next)
        before.push(
          draft(
            `注目は${WATCH_NAME[next]}に切り替える。${watchValue(next, dec)}だよ`,
          ),
        );
      return {
        before,
        after: [],
        watch: next ? makeWatch(next, dec) : null,
        created: next != null,
        settled: "miss",
        nearMiss: current.called
          ? { key: current.key, closestDistance: closest }
          : null,
      };
    }
    if (!current.called && ratio <= WATCH_APPROACH_RATIO)
      return {
        before: [draft(approachWatchText(current.key, dec))],
        after: [],
        watch: { ...current, called: true, closestDistance: closest },
        created: false,
        settled: null,
        nearMiss: null,
      };
    return {
      before: [],
      after: [],
      watch: { ...current, closestDistance: closest },
      created: false,
      settled: null,
      nearMiss: null,
    };
  }

  const target = chooseWatchTarget(dec);
  return target
    ? {
        before: [draft(declareWatchText(target, dec))],
        after: [],
        watch: makeWatch(target, dec),
        created: true,
        settled: null,
        nearMiss: null,
      }
    : {
        before: [],
        after: [],
        watch: null,
        created: false,
        settled: null,
        nearMiss: null,
      };
}

/**
 * The buy-condition chips (EMA / RSI / MACD only), derived from the
 * same evidence as the narration so the two can never disagree.
 * Status words use recorded values only: the EMA gap as a share of
 * price, whole RSI points to the oversold line, the histogram against
 * a small ATR window — and "後退" when the condition was met in the
 * previous cycle and has since broken.
 */
export function entryConditionChips(
  dec: DecisionTelemetry,
  prev: DecisionTrail | null,
): EntryConditionChip[] {
  const emaGap = dec.price > 0 ? (dec.ema50 - dec.ema20) / dec.price : 1;
  const ema: EntryConditionChip = dec.conditions.emaUp
    ? {
        key: "ema",
        label: "EMA",
        met: true,
        status: "✓",
        tone: "met",
        watching: false,
      }
    : prev?.emaUp
      ? {
          key: "ema",
          label: "EMA",
          met: false,
          status: "後退",
          tone: "back",
          watching: false,
        }
      : emaGap <= 0.003
        ? {
            key: "ema",
            label: "EMA",
            met: false,
            status: "あと少し",
            tone: "close",
            watching: false,
          }
        : {
            key: "ema",
            label: "EMA",
            met: false,
            status: "逆並び",
            tone: "far",
            watching: false,
          };
  const points = rsiPoints(dec.rsi, dec.oversold);
  const rsi: EntryConditionChip = dec.conditions.rsiRecovery
    ? {
        key: "rsi",
        label: "RSI",
        met: true,
        status: "✓",
        tone: "met",
        watching: false,
      }
    : prev?.rsiRecovery
      ? {
          key: "rsi",
          label: "RSI",
          met: false,
          status: "後退",
          tone: "back",
          watching: false,
        }
      : dec.rsi <= dec.oversold
        ? {
            key: "rsi",
            label: "RSI",
            met: false,
            status: "圏内",
            tone: "close",
            watching: false,
          }
        : {
            key: "rsi",
            label: "RSI",
            met: false,
            status: `あと${points}`,
            detail: `あと${points}`,
            tone: points <= 3 ? "close" : "far",
            watching: false,
          };
  const macd: EntryConditionChip = dec.conditions.histogramImproving
    ? {
        key: "macd",
        label: "MACD",
        met: true,
        status: "✓",
        tone: "met",
        watching: false,
      }
    : prev?.histogramImproving
      ? {
          key: "macd",
          label: "MACD",
          met: false,
          status: "後退",
          tone: "back",
          watching: false,
        }
      : dec.histogram < 0 &&
          dec.atr > 0 &&
          Math.abs(dec.histogram) <= dec.atr * 0.05
        ? {
            key: "macd",
            label: "MACD",
            met: false,
            status: "あと1",
            tone: "close",
            watching: false,
          }
        : dec.histogram < 0
          ? {
              key: "macd",
              label: "MACD",
              met: false,
              status: "マイナス",
              tone: "far",
              watching: false,
            }
          : {
              key: "macd",
              label: "MACD",
              met: false,
              status: "下向き",
              tone: "far",
              watching: false,
            };
  return [ema, rsi, macd];
}

export const CHIP_KEY_OF_WATCH: Record<EntryCondKey, EntryConditionChip["key"]> = {
  emaUp: "ema",
  rsiRecovery: "rsi",
  histogramImproving: "macd",
};

/**
 * Chips for the snapshot on screen: null unless the decision is
 * fresh (a stale display shows no chips, like it tells no narration).
 * The "previous" trail is whichever decision came right before the
 * one on screen, whether or not the feed has consumed it yet.
 */
export function currentConditionChips(
  state: NarrationState,
  dec: DecisionTelemetry | null | undefined,
  now: number,
): EntryConditionChip[] | null {
  if (!dec || !freshDecision(dec, now)) return null;
  let prev: DecisionTrail | null = null;
  if (state.lastTrail) {
    if (dec.evaluatedAt === state.lastTrail.evaluatedAt) prev = state.prevTrail;
    else if (dec.evaluatedAt > state.lastTrail.evaluatedAt)
      prev = state.lastTrail;
    else prev = state.prevTrail;
  }
  const chips = entryConditionChips(dec, prev);
  if (state.watch)
    for (const chip of chips)
      if (chip.key === CHIP_KEY_OF_WATCH[state.watch.key] && !chip.met)
        chip.watching = true;
  return chips;
}

export const JUST_DECLARED_DETAIL: Record<EntryCondKey, string> = {
  emaUp: "宣言したところ。縮んだら声かける",
  rsiRecovery: "宣言したところ。上抜け待ち",
  histogramImproving: "宣言したところ。プラス転換待ち",
};

/**
 * The "いまの注目" strip for the snapshot on screen: null unless the
 * decision is fresh (same fail-closed rule as the chips). When the
 * bot is stopped, holding, or all conditions are met, there is no
 * watch and the strip says so with the reason; otherwise it shows
 * the declared target — or, for a snapshot the feed has not consumed
 * yet, the target the declaration rule would pick — with its current
 * value and how it has moved since the declaration.
 */
export function currentWatch(
  state: NarrationState,
  dec: DecisionTelemetry | null | undefined,
  vitalState: VitalState,
  now: number,
): WatchDisplay | null {
  if (!dec || !freshDecision(dec, now)) return null;
  if (vitalState === "sleeping" || vitalState === "flatlined")
    return {
      key: null,
      label: "なし",
      value: "",
      detail: "止まってるから注目はお休み",
    };
  if (dec.conditions.hasPosition)
    return {
      key: null,
      label: "なし",
      value: "",
      detail: "保有中。条件が崩れたら声かける",
    };
  if (metEntryConditions(dec) === 3)
    return {
      key: null,
      label: "なし",
      value: "",
      detail: "3つ揃ったので注目は終了",
    };
  const declared =
    state.watch && !dec.conditions[state.watch.key] ? state.watch : null;
  const key = declared ? declared.key : chooseWatchTarget(dec);
  if (!key) return null;
  let detail: string;
  if (declared) {
    const ratio = watchRatio(declared, dec);
    detail =
      declared.declaredDistance > 0 && ratio <= WATCH_APPROACH_RATIO
        ? "宣言時の半分以下。来てる"
        : ratio < 1
          ? "宣言時より縮んだ"
          : ratio > 1
            ? "少し遠のいたけど様子見"
            : JUST_DECLARED_DETAIL[key];
  } else {
    detail = "いちばん届きそうなやつを見てる";
  }
  return { key, label: WATCH_NAME[key], value: watchValue(key, dec), detail };
}

/**
 * The score strip for the snapshot on screen: null unless the
 * decision is fresh (the same fail-closed rule as the chips and the
 * watch strip). The counts are the session's cumulative record;
 * 進行中 simply mirrors whether a watch is live right now.
 */
/** The fixed order kinds are listed and tie-broken in. */
export const WATCH_KIND_ORDER: EntryCondKey[] = [
  "emaUp",
  "rsiRecovery",
  "histogramImproving",
];

/** Record one settled watch in the per-kind stats (pure). */
export function recordWatchKind(
  stats: WatchKindStats,
  key: EntryCondKey,
  settled: "hit" | "miss",
): WatchKindStats {
  const s = stats[key];
  return {
    ...stats,
    [key]: {
      hits: s.hits + (settled === "hit" ? 1 : 0),
      misses: s.misses + (settled === "miss" ? 1 : 0),
    },
  };
}

/** A kind needs at least this many settlements before the feed
 * names it the character's specialty — below that the rate is
 * noise, and the line stays hidden. */
export const SPECIALTY_MIN_JUDGED = 3;

/** The specialty kind: best hit rate among kinds with enough
 * settlements; ties break toward more settlements, then toward
 * the fixed kind order. Null while nothing qualifies. */
export function specialtyOf(
  stats: WatchKindStats,
): { key: EntryCondKey; hits: number; judged: number } | null {
  let best: { key: EntryCondKey; hits: number; judged: number } | null =
    null;
  for (const key of WATCH_KIND_ORDER) {
    const s = stats[key];
    const judged = s.hits + s.misses;
    if (judged < SPECIALTY_MIN_JUDGED) continue;
    if (
      best == null ||
      s.hits / judged > best.hits / best.judged ||
      (s.hits / judged === best.hits / best.judged && judged > best.judged)
    )
      best = { key, hits: s.hits, judged };
  }
  return best;
}

export function currentWatchScore(
  state: NarrationState,
  dec: DecisionTelemetry | null | undefined,
  now: number,
): WatchScoreDisplay | null {
  if (!dec || !freshDecision(dec, now)) return null;
  const specialty = specialtyOf(state.watchKindStats);
  return {
    declared: state.watchScore.declared,
    hits: state.watchScore.hits,
    misses: state.watchScore.misses,
    inProgress: state.watch ? 1 : 0,
    kindStats: state.watchKindStats,
    specialty: specialty
      ? { ...specialty, name: WATCH_NAME[specialty.key] }
      : null,
  };
}

export const reviewPrice = (v: number) => `$${fmtNumber(v, 3)}`;

/** Review lines keep the move readable: one decimal place, signed. */
export const reviewPct = (ratio: number) =>
  `${ratio > 0 ? "+" : ""}${new Intl.NumberFormat("ja-JP", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(ratio)}`;

/**
 * The ふりかえり look-back lines, built ONLY from the recorded
 * session facts handed in: the cumulative declaration score and the
 * price move from the session's first evidence to now. A missing or
 * unusable price omits the price line entirely — the review never
 * invents a move it did not record. The verdict follows the recorded
 * hit/miss balance, nothing else.
 */
export function reviewNarrationTexts(
  score: { declared: number; hits: number; misses: number },
  startPrice: number | null,
  currentPrice: number | null,
  buyMilestone: boolean,
): string[] {
  const verdict =
    score.hits > score.misses
      ? "悪くないね"
      : score.misses > score.hits
        ? "外れが多めだなあ"
        : score.hits > 0
          ? "五分五分だね"
          : "まだ決着なしだね";
  const lines = [
    `ふりかえり。ここまでの宣言は${score.declared}回、的中${score.hits}回、外れ${score.misses}回。${verdict}`,
  ];
  if (
    startPrice != null &&
    currentPrice != null &&
    Number.isFinite(startPrice) &&
    Number.isFinite(currentPrice) &&
    startPrice > 0
  ) {
    const change = currentPrice / startPrice - 1;
    const tail = buyMilestone
      ? "最後は3つ揃ったよ"
      : change > 0.001
        ? "上がってきたね"
        : change < -0.001
          ? "少し下げてるね"
          : "ほぼ横ばいだね";
    lines.push(
      `価格は${reviewPrice(startPrice)}から${reviewPrice(currentPrice)}、${reviewPct(change)}。${tail}`,
    );
  }
  return lines;
}
