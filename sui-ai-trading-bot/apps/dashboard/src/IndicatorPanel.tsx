import React from "react";
import type { Candle } from "../../../packages/shared/src/index.ts";
import { chartTicks, chartTime } from "./chartPresentation.ts";
import { lineSegments } from "./chartIndicators.ts";
import { number } from "./presentation.ts";
export function IndicatorPanel({
  kind,
  candles,
  sets,
  width,
  start,
  end,
  selected,
}: {
  kind: "RSI" | "MACD";
  candles: Candle[];
  sets: (number | null)[][];
  width: number;
  start: number;
  end: number;
  selected: number | null;
}) {
  const valid = sets.flat().filter((v): v is number => v != null),
    min = kind === "RSI" ? 0 : Math.min(0, ...valid),
    max = kind === "RSI" ? 100 : Math.max(0, ...valid),
    x = (t: number) => 22 + ((t - start) / (end - start)) * (width - 44),
    y = (v: number) => 120 - ((v - min) / (max - min || 1)) * 90;
  const index = candles.findIndex((c) => c.timestamp === selected),
    names = kind === "RSI" ? ["RSI14"] : ["MACD", "シグナル", "ヒストグラム"];
  return (
    <section className="linked-indicator" aria-label={`${kind}連動チャート`}>
      <h3>
        {kind} · {candles[0]?.timeframe / 60}分足
      </h3>
      <p aria-label={`${kind}表示期間`}>
        表示期間：{chartTime(start)} ～ {chartTime(end)}（日本時間）
      </p>
      <p>
        選択日時：{selected == null ? "未選択" : chartTime(selected)}
        （足の開始・日本時間）
      </p>
      <svg
        viewBox={`0 0 ${width} 170`}
        role="img"
        aria-label={`${kind}チャート`}
      >
        <text x="2" y="15" fontSize="12" fill="#b0c1cf">
          {number(max, 4)}
        </text>
        <text x="2" y="140" fontSize="12" fill="#b0c1cf">
          {number(min, 4)}
        </text>
        {sets.flatMap((set, j) =>
          lineSegments(candles, set, x, y).map((points, i) => (
            <polyline
              key={`${j}:${i}`}
              fill="none"
              stroke={["#64b5ff", "#edc980", "#b496ee"][j]}
              points={points}
            />
          )),
        )}
        {selected != null && (
          <line
            x1={x(selected + candles[0].timeframe / 2)}
            x2={x(selected + candles[0].timeframe / 2)}
            y1="25"
            y2="125"
            stroke="#b0c1cf"
            strokeDasharray="3 3"
          />
        )}
        {chartTicks(candles, width - 44).map((t, i, a) => (
          <text
            key={t.timestamp}
            x={x(t.timestamp)}
            y="165"
            fontSize="12"
            fill="#b0c1cf"
            textAnchor={
              i === 0 ? "start" : i === a.length - 1 ? "end" : "middle"
            }
          >
            {t.label}
          </text>
        ))}
      </svg>
      <p>
        {names
          .map(
            (name, j) =>
              `${name}：${index < 0 || sets[j][index] == null ? "未計測" : number(sets[j][index], 6)}`,
          )
          .join(" ／ ")}
      </p>
      {!valid.length && (
        <p className="chart-warning">
          データ不足：連続する確定足が60本揃うまで未計測です。
        </p>
      )}
      <small>
        欠損をまたいで線を補間しません。指標の準備に必要な連続足が不足する区間は未計測です。
      </small>
    </section>
  );
}
