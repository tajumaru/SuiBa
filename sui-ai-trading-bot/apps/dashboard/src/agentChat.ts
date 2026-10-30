import type { DecisionTelemetry } from "../../worker/src/operations.ts";
import { sellLinesOf, type WatchScoreDisplay } from "./agentNarration.ts";

/**
 * Record-grounded replies for the narration character. The user
 * can ask from the 実況 tab — by tapping a question chip or typing
 * freely — and the character answers ONLY from the recorded state
 * handed in here (the fresh decision evidence, the watch score,
 * the standing lines, the position). Nothing is invented: a
 * question the records cannot answer gets an honest deflection
 * that names what can be asked instead, and when the decision
 * evidence is not fresh the factual answers say so and stay quiet.
 *
 * Kansai dialect stays out of these replies — it belongs to the
 * emotion-leak lines (near miss, watch hit) only.
 */

export interface AgentChatContext {
  /** The fresh decision evidence, or null when it is not fresh
   * enough to quote (the factual replies then decline). */
  dec: DecisionTelemetry | null;
  /** The watch scoreboard, or null under the same freshness rule. */
  score: WatchScoreDisplay | null;
  /** The standing buy-run line's price, when a line is declared. */
  linePrice: number | null;
  /** The bot is running (not stopped, not safety-stopped). */
  running: boolean;
  /** The bot is plainly stopped and the character is asleep. */
  sleeping: boolean;
}

export const CHAT_CHIPS = [
  "なんで買わないの？",
  "あと何が足りない？",
  "調子は？",
  "ラインまでどれくらい？",
  "がんばれ",
] as const;

const fmtPrice = (v: number) =>
  `$${v.toLocaleString("en-US", { maximumSignificantDigits: 6 })}`;

interface Pieces {
  ema: boolean;
  rsi: boolean;
  macd: boolean;
  missing: string[];
  met: string[];
}

function piecesOf(dec: DecisionTelemetry): Pieces {
  const ema = dec.conditions.emaUp || dec.conditions.emaGapShrinking;
  const rsi = dec.conditions.rsiRecovery;
  const macd = dec.conditions.histogramImproving;
  const all: [string, boolean][] = [
    ["EMA", ema],
    ["RSI", rsi],
    ["MACD", macd],
  ];
  return {
    ema,
    rsi,
    macd,
    missing: all.filter(([, ok]) => !ok).map(([name]) => name),
    met: all.filter(([, ok]) => ok).map(([name]) => name),
  };
}

function whyNotBuying(ctx: AgentChatContext): string {
  if (ctx.sleeping)
    return "いま寝てる（止まってる）から買わないよ。始めたらまた様子を見るね。";
  if (!ctx.running)
    return "いま止まってるから買わないよ。安全側で止まってる時は、まず理由を確認してね。";
  const dec = ctx.dec;
  if (!dec)
    return "様子が掴めてないから、理由ははっきり言えないや。少し待ってから聞いてみて。";
  if (dec.conditions.hasPosition)
    return "もう買って持ってるよ。いまは売りラインを見張ってるところ。";
  const p = piecesOf(dec);
  if (p.missing.length === 0)
    return "条件は全部揃ってる。あとは利益保護の判定待ち — 手数料を引いて残る利益が基準に届けば買うよ。";
  const metText = p.met.length > 0 ? `${p.met.join("と")}は揃ってる。` : "";
  return `${metText}あと${p.missing.join("と")}が足りないから、まだ買わないよ。`;
}

function whatsMissing(ctx: AgentChatContext): string {
  if (!ctx.running)
    return "いま止まってるから、条件以前の話だね。始めたら見張り始めるよ。";
  const dec = ctx.dec;
  if (!dec)
    return "様子が掴めてないから分からないや。少し待ってから聞いてみて。";
  if (dec.conditions.hasPosition)
    return "買い条件はもう済んでるよ。いま足りないのは、売りラインへ届く値動きのほう。";
  const p = piecesOf(dec);
  if (p.missing.length === 0)
    return "条件は全部揃ってるよ。足りないのは利益保護のゴーサインだけ。";
  const parts = [...p.missing];
  if (!p.rsi && dec.rsi > dec.oversold)
    parts.push(`RSIはあと${Math.ceil(dec.rsi - dec.oversold)}`);
  return `足りないのは${parts.join("と")}。揃ったら買いに走るよ。`;
}

function howIsItGoing(ctx: AgentChatContext): string {
  const s = ctx.score;
  if (!s)
    return "様子が掴めてないから、成績は言えないや。少し待ってから聞いてみて。";
  if (s.declared === 0)
    return "まだ宣言は出してないよ。条件が近づいてきたら宣言するから、待ってて。";
  return `宣言${s.declared}回で、的中${s.hits}・外れ${s.misses}、進行中が${s.inProgress}つ。${s.hits >= s.misses ? "悪くないでしょ。" : "次は当てるよ。"}`;
}

function lineDistance(ctx: AgentChatContext): string {
  const dec = ctx.dec;
  if (ctx.linePrice == null || !dec)
    return "いまは買い走りラインは立ってないよ。RSIが最後のピースになったら引くね。";
  const pct = ((dec.price - ctx.linePrice) / dec.price) * 100;
  if (pct <= 0)
    return `買い走りラインは${fmtPrice(ctx.linePrice)}で、もう届いてるよ。次の足の閉じ方次第だね。`;
  return `買い走りラインは${fmtPrice(ctx.linePrice)}。いま${fmtPrice(dec.price)}だから、あと−${pct.toFixed(2)}%まで下がったら届くよ。`;
}

function sellSide(ctx: AgentChatContext): string {
  const dec = ctx.dec;
  if (!dec || !dec.conditions.hasPosition)
    return "まだ何も持ってないから、売りラインは引いてないよ。買えたら利確と損切りのラインを引くね。";
  const lines = sellLinesOf(dec);
  if (!lines)
    return "持ってはいるけど、売りラインの計算材料が揃ってないや。";
  return `利確は${fmtPrice(lines.tp)}、損切りは${fmtPrice(lines.sl)}。どっちかに届いたら売るよ。`;
}

const FALLBACKS = [
  "それはまだ答えられないや。「なんで買わないの？」みたいに聞いてくれたら、今の記録から答えるよ。",
  "うーん、それは分からない。様子・成績・ラインのことなら、今の記録から答えられるよ。",
];

/** The character's reply to one user message, from records only. */
export function agentReply(text: string, ctx: AgentChatContext): string {
  const t = text.replace(/\s+/g, "");
  if (/買わない|買って|なぜ買|なんで買|買わないの/.test(t))
    return whyNotBuying(ctx);
  if (/足りない|あと何|近づ|あとどれ/.test(t)) return whatsMissing(ctx);
  if (/調子|成績|的中/.test(t)) return howIsItGoing(ctx);
  if (/ラインまで|ラインは|指値/.test(t)) return lineDistance(ctx);
  if (/売り|利確|損切り/.test(t)) return sellSide(ctx);
  if (/がんば|頑張|応援/.test(t))
    return "まかせて。条件が揃ったらちゃんと買いに走るから、見てて。";
  if (/こんにちは|おはよう|こんばんは|やあ|ハロー/.test(t))
    return ctx.sleeping
      ? "ん…おはよう。今は止まって寝てるところ。"
      : "やあ、見てくれてありがとう。今の様子なら答えられるよ。";
  if (/ありがとう|ありがと/.test(t)) return "どういたしまして。また聞いて。";
  if (/誰|名前|なまえ/.test(t))
    return "SuiBaの実況担当。相場を見張って、判断をそのまま喋ってるよ。";
  let hash = 0;
  for (const ch of t) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACKS[hash % FALLBACKS.length];
}
