import { calculate, ema } from "../../../packages/indicators/src/index.ts";
import type { Candle } from "../../../packages/shared/src/index.ts";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import type { ForecastAnswerCheck } from "./forecastLog.ts";
import { PriceChart } from "./PriceChart.tsx";
import { dateTime, label, number } from "./presentation.ts";
import type { ShareCardInput } from "./shareCard.ts";

type State = BotSnapshot;

const money = (v: number | null | undefined) => number(v, 4);

export function IndicatorChart({
  candles,
  kind,
  trades,
}: {
  pair?: State["pair"];
  candles: Candle[];
  kind: string;
  trades: State["trades"];
}) {
  const c = candles.slice(-100);
  if (!c.length) return <div className="empty">確定足の取得を待っています</div>;
  const w = 1000,
    h = 220,
    dx = w / c.length;
  let sets: (number | null)[][] = [],
    min = 0,
    max = 100;
  if (kind === "Price") {
    sets = [
      ema(
        candles.map((x) => x.close),
        20,
      ).slice(-100),
      ema(
        candles.map((x) => x.close),
        50,
      ).slice(-100),
    ];
    min = Math.min(...c.map((x) => x.low));
    max = Math.max(...c.map((x) => x.high));
  } else {
    const indicators = candles
      .map((_, i) => (i >= 59 ? calculate(candles.slice(0, i + 1)) : null))
      .slice(-100);
    sets =
      kind === "RSI"
        ? [indicators.map((x) => x?.rsi ?? null)]
        : [
            indicators.map((x) => x?.macd ?? null),
            indicators.map((x) => x?.signal ?? null),
            indicators.map((x) => x?.histogram ?? null),
          ];
    if (kind === "MACD") {
      min = Math.min(0, ...sets.flat().filter((x): x is number => x !== null));
      max = Math.max(0, ...sets.flat().filter((x): x is number => x !== null));
    }
  }
  const y = (v: number) => h - 15 - ((v - min) / (max - min || 1)) * (h - 30);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`${label(kind)}チャート`}
    >
      <text x="4" y="14" fill="#91a5b6" fontSize="12">
        {money(max)}
      </text>
      <text x="4" y="215" fill="#91a5b6" fontSize="12">
        {money(min)}
      </text>
      {kind === "Price" &&
        c.map((b, i) => (
          <g
            key={b.timestamp}
            stroke={b.close >= b.open ? "#43dfb2" : "#f77d8f"}
          >
            <line
              x1={(i + 0.5) * dx}
              x2={(i + 0.5) * dx}
              y1={y(b.high)}
              y2={y(b.low)}
            />
            <rect
              x={(i + 0.2) * dx}
              width={dx * 0.6}
              y={y(Math.max(b.open, b.close))}
              height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
              fill={b.close >= b.open ? "#43dfb2" : "#f77d8f"}
            />
          </g>
        ))}
      {sets.map((set, j) => (
        <polyline
          key={j}
          fill="none"
          stroke={["#64b5ff", "#edc980", "#b496ee"][j]}
          strokeWidth="1.8"
          points={set
            .flatMap((v, i) =>
              v === null ? [] : [`${(i + 0.5) * dx},${y(v)}`],
            )
            .join(" ")}
        />
      ))}
      {kind === "Price" &&
        trades.map((t) => {
          const i = c.findIndex(
            (b) =>
              t.timestamp / 1000 >= b.timestamp &&
              t.timestamp / 1000 < b.timestamp + b.timeframe,
          );
          return i < 0 ? null : (
            <text
              key={t.orderId}
              x={(i + 0.5) * dx}
              y={y(c[i].close) - 10}
              fill={t.side === "BUY" ? "#43dfb2" : "#f77d8f"}
              fontSize="12"
            >
              <title>
                {label(t.side)} · {dateTime(t.timestamp)}
              </title>
              {t.side === "BUY" ? "▲" : "▼"}
            </text>
          );
        })}
    </svg>
  );
}
export function Chart(props: {
  pair?: State["pair"];
  candles: Candle[];
  kind: string;
  trades: State["trades"];
  timeframe?: number;
  synchronized?: boolean;
  historyApi?: import("./settingsPresets.ts").SettingsApi;
  forecastScoreText?: string | null;
  forecastTouchText?: string | null;
  forecastBandScale?: number;
  bookImbalance?: number | null;
  sellLines?: { tp: number; sl: number } | null;
  answerCheck?: ForecastAnswerCheck | null;
  shareCard?: ShareCardInput | null;
}) {
  return props.kind === "Price" ? (
    <PriceChart
      key={props.timeframe ?? props.candles[0]?.timeframe ?? 300}
      {...props}
    />
  ) : (
    <IndicatorChart {...props} />
  );
}
