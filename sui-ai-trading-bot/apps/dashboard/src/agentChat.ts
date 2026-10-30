import type { DecisionTelemetry } from "../../worker/src/operations.ts";
import {
  sellLinesOf,
  type NarrationEntry,
  type WatchScoreDisplay,
} from "./agentNarration.ts";

/**
 * Record-grounded replies for the narration character. The user
 * can ask from the 実況 tab — by tapping a question chip or typing
 * freely — and the character answers ONLY from the recorded state
 * handed in here (the fresh decision evidence, the watch score,
 * the standing lines, the position, the feed's own trade record).
 * Nothing is invented: a question the records cannot answer gets
 * an honest deflection that names what can be asked instead, and
 * when the decision evidence is not fresh the factual answers say
 * so and stay quiet.
 *
 * Every reply also reports its topic, so the UI can offer
 * follow-up chips that continue the same thread — the closest a
 * record-based chat gets to a conversation.
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
  /** How the bot is stopped, when it is: a plain manual stop, a
   * latched safety stop, or a weak/recovering state. */
  stoppedKind: "sleeping" | "safety" | "weak" | null;
  /** Trade entries still present in the feed's own history. */
  tradeCount: number;
  /** The move across the feed's recent price window, in percent,
   * or null when too little is recorded to measure. */
  recentMovePct: number | null;
  /** The topic of the character's previous reply in this
   * conversation (read back from the stored reply entry), or null
   * before the first exchange. Continuations ("それで？") and
   * repeated questions resolve against it. */
  lastTopic: ChatTopic | null;
}

export type ChatTopic =
  | "whyNotBuying"
  | "missing"
  | "score"
  | "line"
  | "sell"
  | "pnl"
  | "stopped"
  | "priceMove"
  | "next"
  | "encouragement"
  | "greeting"
  | "fallback";

export interface AgentReply {
  text: string;
  topic: ChatTopic;
}

export const CHAT_CHIPS = [
  "なんで買わないの？",
  "あと何が足りない？",
  "調子は？",
  "ラインまでどれくらい？",
  "がんばれ",
] as const;

/** Follow-up chips per topic: where the conversation can go next. */
export function followUpChips(topic: ChatTopic): string[] {
  switch (topic) {
    case "whyNotBuying":
      return ["あと何が足りない？", "ラインまでどれくらい？", "次の見どころは？"];
    case "missing":
      return ["なんで買わないの？", "ラインまでどれくらい？", "価格はどう動いた？"];
    case "score":
      return ["次の見どころは？", "損益は？", "なんで買わないの？"];
    case "line":
      return ["あと何が足りない？", "次の見どころは？", "価格はどう動いた？"];
    case "sell":
      return ["損益は？", "次の見どころは？", "調子は？"];
    case "pnl":
      return ["調子は？", "売りラインは？", "次の見どころは？"];
    case "stopped":
      return ["調子は？", "なんで買わないの？", "次の見どころは？"];
    case "priceMove":
      return ["あと何が足りない？", "ラインまでどれくらい？", "次の見どころは？"];
    case "next":
      return ["あと何が足りない？", "調子は？", "ラインまでどれくらい？"];
    default:
      return [...CHAT_CHIPS];
  }
}

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
  if (ctx.stoppedKind === "sleeping")
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

function pnl(ctx: AgentChatContext): string {
  if (ctx.tradeCount === 0)
    return "まだ約定が1件もないから、損益はゼロのまま。正確な数字は概要タブの累計損益がいちばん確かだよ。";
  return `この実況に残ってる範囲だと約定は${ctx.tradeCount}件あるよ。正確な損益は概要タブの累計損益で確認して。`;
}

function stopped(ctx: AgentChatContext): string {
  switch (ctx.stoppedKind) {
    case "sleeping":
      return "手動で止まってるよ。止めた理由までは記録に残らないんだ。";
    case "safety":
      return "安全停止がかかってる。市場や板の異常を検知した時のかたちで、詳しい理由は運用バーの下と、戦略タブの「解除の手順」に出てるよ。";
    case "weak":
      return "いまは復旧確認中か、通信が不安定で様子見してるところ。落ち着けば自分で戻るよ。";
    default:
      return ctx.running
        ? "止まってないよ、動いてる。様子はこの実況のとおり。"
        : "様子が掴めてないから、止まってる理由ははっきり言えないや。";
  }
}

function priceMove(ctx: AgentChatContext): string {
  const dec = ctx.dec;
  if (ctx.recentMovePct == null)
    return "まだ動きを測れるほど価格の記録が貯まってないや。もう少し見てて。";
  const pct = ctx.recentMovePct;
  const dir = pct > 0.05 ? "上がり気味" : pct < -0.05 ? "下がり気味" : "ほぼ横ばい";
  const now = dec ? `いま${fmtPrice(dec.price)}。` : "";
  return `ここしばらくの記録では${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%で、${dir}。${now}`;
}

function nextHighlight(ctx: AgentChatContext): string {
  const dec = ctx.dec;
  if (ctx.linePrice != null && dec) {
    const pct = ((dec.price - ctx.linePrice) / dec.price) * 100;
    return pct > 0
      ? `買い走りライン（${fmtPrice(ctx.linePrice)}、あと−${pct.toFixed(2)}%）に届くかどうかが次の見どころ。`
      : "買い走りラインに届いてるから、次の足の閉じ方が見どころ。";
  }
  if (dec?.conditions.hasPosition)
    return "売りライン（利確・損切り）に価格が近づくかどうかが見どころ。";
  if (ctx.score && ctx.score.inProgress > 0)
    return "いま注目してる条件が揃うかどうかが見どころ。当たればドヤるよ。";
  if (dec) {
    const p = piecesOf(dec);
    if (p.missing.length > 0)
      return `${p.missing.join("と")}が揃うかどうかが次の見どころ。`;
    return "条件は揃ってるから、利益保護の判定が見どころ。";
  }
  return "様子が掴めたら、近づいてる条件から見どころを言うね。";
}

const FALLBACKS = [
  "それはまだ答えられないや。「あと何が足りない？」「損益は？」「次の見どころは？」みたいに聞いてくれたら、今の記録から答えるよ。",
  "うーん、それは分からない。様子・成績・ライン・損益のことなら、今の記録から答えられるよ。",
];

/** The factual answer for a topic, or null for the social topics
 * (greeting / encouragement / fallback), which have no deeper
 * thread to continue. */
function topicAnswer(topic: ChatTopic, ctx: AgentChatContext): string | null {
  switch (topic) {
    case "whyNotBuying":
      return whyNotBuying(ctx);
    case "missing":
      return whatsMissing(ctx);
    case "score":
      return howIsItGoing(ctx);
    case "line":
      return lineDistance(ctx);
    case "sell":
      return sellSide(ctx);
    case "pnl":
      return pnl(ctx);
    case "stopped":
      return stopped(ctx);
    case "priceMove":
      return priceMove(ctx);
    case "next":
      return nextHighlight(ctx);
    default:
      return null;
  }
}

/** Where "それで？" naturally goes from each topic. */
const NEXT_IN_THREAD: Partial<Record<ChatTopic, ChatTopic>> = {
  whyNotBuying: "missing",
  missing: "next",
  line: "missing",
  score: "next",
  pnl: "score",
  priceMove: "missing",
  sell: "pnl",
  stopped: "score",
  next: "missing",
};

/** The character's reply to one user message, from records only. */
export function agentReply(text: string, ctx: AgentChatContext): AgentReply {
  const t = text.replace(/\s+/g, "");
  const say = (topic: ChatTopic, body: string): AgentReply => ({
    text: body,
    topic,
  });
  // Conversation memory first: a bare continuation or a bare
  // "why" only means something against the previous topic.
  if (/^(それで|それから|んで|でさ|続き)/.test(t)) {
    const nextTopic =
      ctx.lastTopic != null
        ? (NEXT_IN_THREAD[ctx.lastTopic] ?? ctx.lastTopic)
        : null;
    const body = nextTopic != null ? topicAnswer(nextTopic, ctx) : null;
    if (nextTopic != null && body != null)
      return say(nextTopic, `うん、続きを言うと — ${body}`);
    return say(
      "fallback",
      "何の続きか分からないや。まず「調子は？」みたいに聞いてみて。",
    );
  }
  if (/^(なんで|なぜ)[？?]?$/.test(t) && ctx.lastTopic != null)
    return say("whyNotBuying", whyNotBuying(ctx));
  let topic: ChatTopic | null = null;
  if (/買わない|買って|なぜ買|なんで買/.test(t)) topic = "whyNotBuying";
  else if (/足りない|あと何|近づ|あとどれ/.test(t)) topic = "missing";
  else if (/調子|成績|的中/.test(t)) topic = "score";
  else if (/売りライン|利確|損切り/.test(t)) topic = "sell";
  else if (/ラインまで|ラインは|指値/.test(t)) topic = "line";
  else if (/売り/.test(t)) topic = "sell";
  else if (/損益|儲か|利益は|プラス|マイナス/.test(t)) topic = "pnl";
  else if (/止ま|停止/.test(t)) topic = "stopped";
  else if (/価格|動いた|値動き|上がっ|下がっ/.test(t)) topic = "priceMove";
  else if (/見どころ|次は|次に/.test(t)) topic = "next";
  if (topic != null) {
    const body = topicAnswer(topic, ctx)!;
    // The same question twice in a row gets a fresh answer from
    // the current records, acknowledged as a repeat.
    if (topic === ctx.lastTopic)
      return say(topic, `さっきも言ったけど、${body}`);
    return say(topic, body);
  }
  if (/がんば|頑張|応援/.test(t))
    return say(
      "encouragement",
      "まかせて。条件が揃ったらちゃんと買いに走るから、見てて。",
    );
  if (/こんにちは|おはよう|こんばんは|やあ|ハロー/.test(t))
    return say(
      "greeting",
      ctx.stoppedKind === "sleeping"
        ? "ん…おはよう。今は止まって寝てるところ。"
        : "やあ、見てくれてありがとう。今の様子なら答えられるよ。",
    );
  if (/ありがとう|ありがと/.test(t))
    return say("greeting", "どういたしまして。また聞いて。");
  if (/誰|名前|なまえ/.test(t))
    return say(
      "greeting",
      "SuiBaの実況担当。相場を見張って、判断をそのまま喋ってるよ。",
    );
  let hash = 0;
  for (const ch of t) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return say("fallback", FALLBACKS[hash % FALLBACKS.length]);
}

export interface ProactivePrompt {
  text: string;
  chip: string;
}

/**
 * The character speaking up at a narration milestone: a line was
 * declared, a watch hit, a near miss landed, a buy filled, or a
 * sudden move broke in. Returns the prompt and the question chip
 * it offers, or null for entries that are not milestones.
 */
export function proactivePrompt(
  entry: Pick<NarrationEntry, "kind" | "side">,
): ProactivePrompt | null {
  switch (entry.kind) {
    case "priceLine":
      return {
        text: "ライン立ったよ。届くまでどれくらいか、聞く？",
        chip: "ラインまでどれくらい？",
      };
    case "watchHit":
      return { text: "宣言、当たったよ！成績、聞く？", chip: "調子は？" };
    case "nearMiss":
      return {
        text: "あと少しのところで外れた…。何が足りなかったか、聞く？",
        chip: "あと何が足りない？",
      };
    case "alert":
      return {
        text: "急に動いたよ。価格の動き、聞く？",
        chip: "価格はどう動いた？",
      };
    case "trade":
      return entry.side === "BUY"
        ? { text: "買えたよ！売りラインも引いた。見る？", chip: "売りラインは？" }
        : null;
    default:
      return null;
  }
}
