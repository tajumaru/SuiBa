import React, { useEffect, useRef } from "react";
import type { Candle } from "../../../packages/shared/src/index.ts";
import { chartTicks, chartTime } from "./chartPresentation.ts";
import { lineSegments } from "./chartIndicators.ts";
import { number } from "./presentation.ts";
export function IndicatorPanel({
  interaction,
  onZoom,
  kind,
  candles,
  sets,
  width,
  start,
  end,
  dataEnd,
  selected,
  lineValue,
  lineLabel,
}: {
  interaction?: React.SVGProps<SVGSVGElement>;
  onZoom?: (factor: number) => void;
  kind: "RSI" | "MACD";
  candles: Candle[];
  sets: (number | null)[][];
  width: number;
  start: number;
  end: number;
  /** End of the historical window, excluding the forecast-only space. */
  dataEnd: number;
  selected: number | null;
  /** A reference level drawn across the pane (the RSI pane
   * passes the oversold setting: the level the buy run starts
   * from). Drawn only when it sits inside the pane's range. */
  lineValue?: number | null;
  lineLabel?: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        onZoom?.(e.deltaY > 0 ? 1.5 : 1 / 1.5);
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [onZoom]);
  const valid = sets.flat().filter((v): v is number => v != null),
    min = kind === "RSI" ? 0 : Math.min(0, ...valid),
    max = kind === "RSI" ? 100 : Math.max(0, ...valid),
    x = (t: number) => 22 + ((t - start) / (end - start)) * (width - 44),
    y = (v: number) => 120 - ((v - min) / (max - min || 1)) * 90;
  const index = candles.findIndex((c) => c.timestamp === selected),
    names = kind === "RSI" ? ["RSI14"] : ["MACD", "シグナル", "ヒストグラム"];
  const lineY =
      lineValue != null &&
      Number.isFinite(lineValue) &&
      lineValue >= min &&
      lineValue <= max
        ? y(lineValue)
        : null,
    lineText = lineY != null ? `${lineLabel ?? "買いライン"} ${lineValue}` : "",
    lineChipW =
      [...lineText].reduce(
        (sum, ch) => sum + (ch.charCodeAt(0) > 0x2000 ? 11 : 6.4),
        0,
      ) + 16,
    lineChipX = width - 22 - lineChipW,
    lineChipY = lineY != null ? Math.min(125 - 18, Math.max(25, lineY - 9)) : 0;
  return (
    <section
      className="linked-indicator chart-meta"
      aria-label={`${kind}連動チャート`}
    >
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
        ref={svg}
        tabIndex={0}
        className="interactive-price-chart"
        {...interaction}
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
        {lineY != null && (
          <g className="chart-buy-line" aria-label="買いライン">
            <line
              x1={22}
              x2={width - 22}
              y1={lineY}
              y2={lineY}
              stroke="#64b5ff"
              strokeWidth="1.4"
              strokeDasharray="7 4"
            />
            <rect
              x={lineChipX}
              y={lineChipY}
              width={lineChipW}
              height={18}
              rx="4"
              fill="#10325c"
              stroke="#62b2ff"
              strokeOpacity="0.6"
            />
            <text
              x={lineChipX + lineChipW / 2}
              y={lineChipY + 13}
              fill="#bfe0ff"
              fontSize="11"
              fontWeight="700"
              textAnchor="middle"
            >
              {lineText}
            </text>
          </g>
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
      {candles.length > 0 &&
        (dataEnd - start) / candles[0].timeframe > candles.length && (
          <p className="chart-warning">
            データ不足：表示期間に欠損があります。
          </p>
        )}
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
