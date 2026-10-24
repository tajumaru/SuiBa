import React, { useEffect, useMemo, useState } from "react";
import {
  dateTime,
  number as format,
  label,
  reason as reasonText,
} from "./presentation.ts";
import { Reason } from "./Reason.tsx";
import {
  REPLAY_SPEEDS,
  replayFrame,
  replayIntervalMs,
  replayLength,
  type ReplayMode,
  type ReplaySpeed,
} from "./backtestReplay.ts";
import type { ComparisonResult } from "../../../packages/backtest-engine/src/index.ts";

const MODE_COLOR: Record<ReplayMode, string> = {
  on: "#43dfb2",
  off: "#70b9ff",
};

function PriceReplayChart({
  result,
  mode,
  index,
}: {
  result: ComparisonResult;
  mode: ReplayMode;
  index: number;
}) {
  const bars = result.candles;
  const total = Math.min(bars.length, result[mode].events.length);
  const min = Math.min(...bars.map((b) => b.low));
  const max = Math.max(...bars.map((b) => b.high));
  const span = max - min || 1;
  const x = (i: number) => 25 + (i * 950) / Math.max(total - 1, 1);
  const y = (p: number) => 190 - ((p - min) / span) * 160;
  const line = (upto: number) =>
    bars
      .slice(0, upto + 1)
      .map((b, i) => `${x(i)},${y(b.close)}`)
      .join(" ");
  const current = bars[index];
  return (
    <svg
      viewBox="0 0 1000 220"
      role="img"
      aria-label="再生中の価格推移と売買地点"
    >
      <polyline
        fill="none"
        stroke="#314b61"
        strokeWidth="2"
        points={line(total - 1)}
      />
      <polyline
        fill="none"
        stroke={MODE_COLOR[mode]}
        strokeWidth="2"
        points={line(index)}
      />
      {result[mode].events.slice(0, index + 1).map((e, i) =>
        e.trade ? (
          <text
            key={e.timestamp}
            x={x(i)}
            y={y(e.trade.price) + (e.trade.side === "BUY" ? 16 : -8)}
            fontSize="14"
            textAnchor="middle"
            fill={e.trade.side === "BUY" ? "#43dfb2" : "#f77d8f"}
          >
            <title>
              {dateTime(e.timestamp)} · {label(e.trade.side)}{" "}
              {format(e.trade.quantity)} SUI
            </title>
            {e.trade.side === "BUY" ? "▲" : "▼"}
          </text>
        ) : null,
      )}
      <line
        x1={x(index)}
        y1={20}
        x2={x(index)}
        y2={195}
        stroke="#dce8f0"
        strokeDasharray="4 4"
        opacity={0.6}
      />
      <circle cx={x(index)} cy={y(current.close)} r="6" fill="#dce8f0" />
      <text x="10" y="18" fill="#8fa7b9" fontSize="12">
        {format(max)} USDC
      </text>
      <text x="10" y="216" fill="#8fa7b9" fontSize="12">
        {format(min)} USDC · ▲ 買い · ▼ 売り · 破線が現在の足
      </text>
    </svg>
  );
}

function EquityReplayChart({
  result,
  mode,
  index,
}: {
  result: ComparisonResult;
  mode: ReplayMode;
  index: number;
}) {
  const curve = result[mode].curve;
  const values = [result.options.initialUsdc, ...curve.map((p) => p.equity)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  // values[0] is the initial equity; values[j] for j >= 1 is curve[j - 1].
  const x = (j: number) => 25 + (j * 950) / Math.max(curve.length, 1);
  const y = (v: number) => 130 - ((v - min) / span) * 100;
  const elapsed = values.slice(0, index + 2);
  return (
    <svg viewBox="0 0 1000 160" role="img" aria-label="再生中の資産推移">
      <polyline
        fill="none"
        stroke="#314b61"
        strokeWidth="2"
        points={values.map((v, j) => `${x(j)},${y(v)}`).join(" ")}
      />
      <polyline
        fill="none"
        stroke={MODE_COLOR[mode]}
        strokeWidth="2"
        points={elapsed.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
      />
      <line
        x1={25}
        y1={y(result.options.initialUsdc)}
        x2={975}
        y2={y(result.options.initialUsdc)}
        stroke="#8fa7b9"
        strokeDasharray="4 4"
        opacity={0.5}
      />
      <circle
        cx={x(index + 1)}
        cy={y(values[index + 1])}
        r="5"
        fill="#dce8f0"
      />
      <text x="10" y="18" fill="#8fa7b9" fontSize="12">
        資産 {format(max)} USDC · 破線は初期資産
      </text>
      <text x="10" y="154" fill="#8fa7b9" fontSize="12">
        {format(min)} USDC
      </text>
    </svg>
  );
}

export function BacktestReplay({ result }: { result: ComparisonResult }) {
  const [mode, setMode] = useState<ReplayMode>("on");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(4);
  const total = replayLength(result, mode);
  const frame = useMemo(
    () => replayFrame(result, mode, index),
    [result, mode, index],
  );

  // A new comparison (or switching the profit-guard run) restarts the replay.
  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [result, mode]);

  useEffect(() => {
    if (!playing) return;
    if (index >= total - 1) {
      setPlaying(false);
      return;
    }
    const id = setInterval(
      () => setIndex((i) => Math.min(total - 1, i + 1)),
      replayIntervalMs(speed),
    );
    return () => clearInterval(id);
  }, [playing, speed, total, index >= total - 1]);

  if (!frame || total < 2) return null;
  const run = result[mode];
  const togglePlay = () => {
    if (!playing && frame.isEnd) setIndex(0);
    setPlaying(!playing);
  };
  const step = (delta: number) => {
    setPlaying(false);
    setIndex((i) => Math.min(total - 1, Math.max(0, i + delta)));
  };
  const jump = (to: number) => {
    setPlaying(false);
    setIndex(Math.min(total - 1, Math.max(0, to)));
  };

  return (
    <section aria-label="バックテスト再生モード">
      <h3>再生モード · Botの判断を1本ずつ追体験</h3>
      <p>
        比較結果を再計算せず、そのまま時間順に再生します。再生位置の価格・資産・保有量・約定は、下の比較表・履歴と同じ結果から切り出したものです。
      </p>
      <div className="replay-controls">
        <label>
          再生する結果
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ReplayMode)}
          >
            <option value="on">利益保護あり</option>
            <option value="off">利益保護なし</option>
          </select>
        </label>
        <div className="controls" role="group" aria-label="再生操作">
          <button type="button" onClick={() => jump(0)} disabled={index === 0}>
            ⏮ 最初へ
          </button>
          <button type="button" onClick={() => step(-1)} disabled={index === 0}>
            ◀ 1本戻る
          </button>
          <button
            type="button"
            onClick={togglePlay}
            aria-pressed={playing}
            className="replay-play"
          >
            {playing ? "⏸ 一時停止" : frame.isEnd ? "↻ もう一度再生" : "▶ 再生"}
          </button>
          <button type="button" onClick={() => step(1)} disabled={frame.isEnd}>
            1本進む ▶
          </button>
          <button
            type="button"
            onClick={() => jump(total - 1)}
            disabled={frame.isEnd}
          >
            最後へ ⏭
          </button>
        </div>
        <label>
          再生速度
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value) as ReplaySpeed)}
          >
            {REPLAY_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}倍速
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="replay-scrub">
        再生位置：{frame.index + 1} / {frame.total} 本 ·{" "}
        {dateTime(frame.candle.timestamp * 1000)}
        <input
          type="range"
          min={0}
          max={frame.total - 1}
          step={1}
          value={frame.index}
          onChange={(e) => jump(Number(e.target.value))}
          aria-label="再生位置"
        />
      </label>
      <div className="cards replay-status">
        <div>
          <small>現在価格 SUI/USDC</small>
          <strong>{format(frame.candle.close)}</strong>
        </div>
        <div>
          <small>資産 USDC</small>
          <strong>{format(frame.equity)}</strong>
          <small>
            初期比 {frame.returnPct >= 0 ? "+" : ""}
            {format(frame.returnPct)}%
          </small>
        </div>
        <div>
          <small>保有 SUI / ドローダウン</small>
          <strong>{format(frame.holdingsSui)}</strong>
          <small>DD {format(frame.drawdown * 100)}%</small>
        </div>
        <div>
          <small>約定（買い / 売り）</small>
          <strong>
            {frame.buyCount} / {frame.sellCount}
          </strong>
          <small>実現損益 {format(frame.realizedPnl)} USDC</small>
        </div>
      </div>
      <PriceReplayChart result={result} mode={mode} index={frame.index} />
      <EquityReplayChart result={result} mode={mode} index={frame.index} />
      <div className="replay-now" role="status">
        <strong>
          この足の判断：{label(frame.event.decision.action)} /{" "}
          {label(frame.event.status)}
          {frame.event.trade
            ? ` · ${label(frame.event.trade.side)} ${format(frame.event.trade.quantity)} SUI @ ${format(frame.event.trade.price)} USDC`
            : ""}
        </strong>
        <p>
          {frame.event.reasons.map((code, i) => (
            <span key={i}>
              {i > 0 ? "、" : ""}
              <Reason code={code} />
            </span>
          ))}
        </p>
      </div>
      <ol className="replay-feed" aria-label="直近の判断">
        {frame.recentEvents.map((e) => (
          <li
            key={e.timestamp}
            data-current={e.timestamp === frame.event.timestamp}
          >
            <span>{dateTime(e.timestamp)}</span>
            <span>
              {label(e.decision.action)} / {label(e.status)}
              {e.trade
                ? ` · ${format(e.trade.quantity)} SUI @ ${format(e.trade.price)}`
                : ` · ${e.reasons.map(reasonText).join("、")}`}
            </span>
          </li>
        ))}
      </ol>
      {frame.isEnd && (
        <p className="replay-end" role="status">
          再生終了 — 最終資産 {format(run.summary.finalEquity)} USDC（リターン{" "}
          {format(run.summary.totalReturnPct)}% · 約定 {run.summary.tradeCount}{" "}
          回）。全体の結果は下の比較表で確認できます。
        </p>
      )}
    </section>
  );
}
