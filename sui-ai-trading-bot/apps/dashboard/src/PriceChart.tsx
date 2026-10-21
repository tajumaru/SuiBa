import React, { useMemo, useState } from "react";
import type { Candle } from "../../../packages/shared/src/index.ts";
import type { BotEngine } from "../../worker/src/engine.ts";
import {
  chartPeriods,
  chartData,
  chartWindow,
  chartTime,
  chartTicks,
} from "./chartPresentation.ts";
import { number } from "./presentation.ts";
export function PriceChart({
  candles,
  trades,
  timeframe = 300,
}: {
  candles: Candle[];
  trades: ReturnType<BotEngine["snapshot"]>["trades"];
  timeframe?: number;
}) {
  const data = useMemo(() => chartData(candles), [candles]);
  const [hours, setHours] = useState<number>(6);
  const visible = chartWindow(data, hours * 3600);
  const c = visible.candles;
  if (!c.length)
    return (
      <div className="price-chart">
        <p>SUI / USDC · {timeframe / 60}分足</p>
        <p>期間を取得できません</p>
        <p>確定足の取得を待っています。表示可能なローソク足がありません。</p>
      </div>
    );
  const w = 1000,
    h = 260,
    start = visible.start!,
    end = visible.end!,
    x = (t: number) => 50 + ((t - start) / (end - start)) * 900;
  const values = [
    ...c.flatMap((b) => [b.low, b.high]),
    ...visible.ema20,
    ...visible.ema50,
  ].filter((v): v is number => v != null);
  const min = Math.min(...values),
    max = Math.max(...values),
    y = (v: number) => 210 - ((v - min) / (max - min || 1)) * 180,
    dx = Math.max(
      1,
      Math.min(20, (900 / (end - start)) * c[0].timeframe * 0.6),
    );
  return (
    <div className="price-chart">
      <p>
        <strong>SUI / USDC · {c[0].timeframe / 60}分足</strong>
      </p>
      <div className="chart-controls" role="group" aria-label="表示期間の選択">
        {chartPeriods.map((n) => (
          <button
            key={n}
            aria-pressed={hours === n}
            onClick={() => setHours(n)}
          >
            {n === 168 ? "7日" : `${n}時間`}
          </button>
        ))}
      </div>
      <p>選択期間：{hours === 168 ? "7日" : `${hours}時間`}</p>
      {visible.available < hours * 3600 && (
        <p className="chart-warning" role="status">
          データ不足：選択した期間の全データはありません。取得済みの最大
          {number(visible.available / 3600, 2)}
          時間を表示しています。追加のAPI取得は行いません。
        </p>
      )}
      <p aria-label="実際の表示期間">
        表示期間：{chartTime(start)} ～ {chartTime(end)}（日本時間）
      </p>
      <p>
        表示範囲：{number((end - start) / 3600, 2)}時間 ／ {c.length}
        本。開始は最初の足の開始、終了は最後の足の終了です。
      </p>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="価格チャート">
        <text x="2" y="15" fill="#b0c1cf">
          {number(max, 4)}
        </text>
        <text x="2" y="210" fill="#b0c1cf">
          {number(min, 4)}
        </text>
        {c.map((b) => (
          <g
            key={b.timestamp}
            stroke={b.close >= b.open ? "#43dfb2" : "#f77d8f"}
          >
            <line
              x1={x(b.timestamp + b.timeframe / 2)}
              x2={x(b.timestamp + b.timeframe / 2)}
              y1={y(b.high)}
              y2={y(b.low)}
            />
            <rect
              x={x(b.timestamp + b.timeframe / 2) - dx / 2}
              width={dx}
              y={y(Math.max(b.open, b.close))}
              height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
              fill="currentColor"
            />
          </g>
        ))}
        {[visible.ema20, visible.ema50].map((set, j) => (
          <polyline
            key={j}
            fill="none"
            stroke={["#64b5ff", "#edc980"][j]}
            points={set
              .flatMap((v, i) =>
                v == null
                  ? []
                  : [`${x(c[i].timestamp + c[i].timeframe / 2)},${y(v)}`],
              )
              .join(" ")}
          />
        ))}
        {chartTicks(c, w).map((t) => (
          <text
            key={t.timestamp}
            x={x(t.timestamp)}
            y="250"
            fill="#b0c1cf"
            textAnchor="middle"
            fontSize="12"
          >
            {t.label}
          </text>
        ))}
      </svg>
      <p>EMA20（青）／ EMA50（黄）</p>
    </div>
  );
}
