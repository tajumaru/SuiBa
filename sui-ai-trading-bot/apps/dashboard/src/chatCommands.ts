/**
 * Slash commands for the character chat: a small console inside
 * the conversation. A message starting with "/" is a command,
 * answered from the same recorded facts as the natural replies
 * (the shared AgentChatContext) but formatted as a terminal
 * readout — Latin labels, dot leaders, monospace. Command
 * replies are never spoken aloud and carry no chat topic, so
 * they never disturb the conversation memory.
 */
import type { AgentChatContext } from "./agentChat.ts";

export interface ChatCommand {
  name: string;
  hint: string;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  { name: "/status", hint: "いまの状態" },
  { name: "/score", hint: "注目の成績" },
  { name: "/line", hint: "買い走りライン" },
  { name: "/ping", hint: "応答テスト" },
  { name: "/help", hint: "コマンド一覧" },
];

export function isCommandText(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/** Commands matching what the user has typed so far. */
export function commandSuggestions(input: string): ChatCommand[] {
  const typed = input.trimStart().toLowerCase();
  return CHAT_COMMANDS.filter((c) => c.name.startsWith(typed));
}

function row(label: string, value: string): string {
  const dots = ".".repeat(Math.max(2, 10 - label.length));
  return `${label} ${dots} ${value}`;
}

function statusText(ctx: AgentChatContext): string {
  const lines: string[] = [];
  lines.push(
    row(
      "status",
      ctx.running
        ? "運用中"
        : ctx.stoppedKind === "safety"
          ? "安全停止中"
          : ctx.stoppedKind === "weak"
            ? "様子見（弱）"
            : "停止中",
    ),
  );
  lines.push(row("pair", `${ctx.pairLabel} / USDC`));
  const dec = ctx.dec;
  if (dec) {
    lines.push(row("price", `$${dec.price}`));
    lines.push(row("rsi", `${dec.rsi}（売られすぎ ${dec.oversold}）`));
    const marks: string[] = [
      `EMA ${dec.conditions.emaUp || dec.conditions.emaGapShrinking ? "ok" : "--"}`,
      `RSI ${dec.conditions.rsiRecovery ? "ok" : "--"}`,
      `MACD ${dec.conditions.histogramImproving ? "ok" : "--"}`,
    ];
    lines.push(row("cond", marks.join(" / ")));
    lines.push(row("pos", dec.conditions.hasPosition ? "保有中" : "なし"));
  } else {
    lines.push(row("price", "確認中"));
  }
  lines.push(row("trades", `${ctx.tradeCount} 件（記録分）`));
  if (ctx.recentMovePct != null) {
    const sign = ctx.recentMovePct >= 0 ? "+" : "";
    lines.push(row("move", `${sign}${ctx.recentMovePct.toFixed(2)}%（直近）`));
  }
  return lines.join("\n");
}

function scoreText(ctx: AgentChatContext): string {
  const score = ctx.score;
  if (!score) return "score .... まだ集計なし（記録が新しい）";
  const judged = score.hits + score.misses;
  const rate =
    judged > 0 ? `${Math.round((score.hits / judged) * 100)}%` : "--";
  return [
    row("declared", `${score.declared}`),
    row("live", `${score.inProgress}`),
    row("hit", `${score.hits}`),
    row("miss", `${score.misses}`),
    row("hit-rate", rate),
  ].join("\n");
}

function lineText(ctx: AgentChatContext): string {
  if (ctx.linePrice == null)
    return [
      row("line", "立っていない"),
      ...(ctx.dec
        ? [row("rsi", `${ctx.dec.rsi}（売られすぎ ${ctx.dec.oversold}）`)]
        : []),
    ].join("\n");
  const lines = [row("line", `$${ctx.linePrice}`)];
  if (ctx.dec) {
    const gapPct = (ctx.dec.price / ctx.linePrice - 1) * 100;
    lines.push(row("price", `$${ctx.dec.price}`));
    lines.push(row("gap", `あと ${gapPct.toFixed(2)}% 下がると到達`));
  }
  return lines.join("\n");
}

function helpText(): string {
  return [
    "commands:",
    ...CHAT_COMMANDS.map((c) => `  ${c.name.padEnd(8)} ${c.hint}`),
  ].join("\n");
}

export function runChatCommand(raw: string, ctx: AgentChatContext): string {
  const name = raw.trimStart().split(/\s+/)[0].toLowerCase();
  switch (name) {
    case "/status":
      return statusText(ctx);
    case "/score":
      return scoreText(ctx);
    case "/line":
      return lineText(ctx);
    case "/ping":
      return "pong";
    case "/help":
      return helpText();
    default:
      return `unknown command: ${name}\n/help で一覧が見れる`;
  }
}
