import React, { useMemo, useState, useEffect, useRef } from "react";
import type { Candle } from "../../../packages/shared/src/index.ts";
import type { BotEngine } from "../../worker/src/engine.ts";
import {
  chartPeriods,
  chartData,
  chartWindow,
  chartTime,
  chartTicks,
} from "./chartPresentation.ts";
import { number, dateTime, label } from "./presentation.ts";
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
  const [hours, setHours] = useState(6),
    [span, setSpan] = useState(21600),
    [anchor, setAnchor] = useState<number | undefined>(),
    [selected, setSelected] = useState<number | null>(null),
    [width, setWidth] = useState(900);
  const host = useRef<HTMLDivElement>(null),
    svg = useRef<SVGSVGElement>(null),
    drag = useRef<{
      x: number;
      y: number;
      end: number;
      span: number;
      moved: boolean;
    } | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(280, entry.contentRect.width)),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const visible = useMemo(
      () => chartWindow(data, span, anchor),
      [data, span, anchor],
    ),
    c = visible.candles;
  const latest = data.candles.at(-1),
    latestEnd = latest ? latest.timestamp + latest.timeframe : 0,
    tf = latest?.timeframe ?? timeframe;
  const first = data.candles[0]?.timestamp ?? 0,
    available = latestEnd - first,
    end = anchor ?? latestEnd;
  const choosePeriod = (n: number) => {
    setHours(n);
    setSpan(n * 3600);
    setAnchor(undefined);
    setSelected(null);
  };
  const zoom = (factor: number) =>
    setSpan((v) =>
      Math.min(
        Math.max(tf, Math.min(v, available) * factor),
        Math.max(tf, available),
      ),
    );
  const move = (delta: number) => {
    const size = Math.min(span, available);
    setAnchor(Math.min(latestEnd, Math.max(first + size, end + delta)));
  };
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom(e.deltaY > 0 ? 1.5 : 1 / 1.5);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [tf, available, c.length]);
  const w = width,
    h = 280,
    left = 22,
    right = w - 22,
    plot = right - left,
    start = visible.start ?? 0,
    finish = visible.end ?? 1;
  const x = (t: number) => left + ((t - start) / (finish - start)) * plot;
  const values = [
    ...c.flatMap((b) => [b.low, b.high]),
    ...visible.ema20,
    ...visible.ema50,
  ].filter((v): v is number => v != null);
  const min = Math.min(...values),
    max = Math.max(...values),
    y = (v: number) => 215 - ((v - min) / (max - min || 1)) * 180;
  const dx = Math.max(0.8, Math.min(24, (plot / (finish - start)) * tf * 0.6));
  const chosen = c.find((b) => b.timestamp === selected) ?? c.at(-1);
  const pick = (clientX: number) => {
    if (!svg.current || !c.length) return;
    const rect = svg.current.getBoundingClientRect(),
      t =
        start +
        ((((clientX - rect.left) / rect.width) * w - left) / plot) *
          (finish - start);
    const nearest = c.reduce((a, b) =>
      Math.abs(b.timestamp + tf / 2 - t) < Math.abs(a.timestamp + tf / 2 - t)
        ? b
        : a,
    );
    setSelected(nearest.timestamp);
  };
  const reconstructed = (b: Candle) =>
    b.provenance != null && b.provenance.origin !== "ORIGINAL";
  const origin = (b: Candle) =>
    !b.provenance
      ? "再構築情報なし"
      : b.provenance.origin === "ORIGINAL"
        ? "元データ"
        : b.provenance.origin === "ONE_MINUTE_AGGREGATE"
          ? "再構築（確定1分足から集約）"
          : "再構築（無約定確認済み）";
  return (
    <div className="price-chart" ref={host} aria-label="SUI/USDC価格表示">
      <p>
        <strong>SUI / USDC · {tf / 60}分足</strong>
      </p>
      <div className="chart-controls" role="group" aria-label="表示期間の選択">
        {chartPeriods.map((n) => (
          <button
            key={n}
            aria-pressed={hours === n}
            onClick={() => choosePeriod(n)}
          >
            {n === 168 ? "7日" : `${n}時間`}
          </button>
        ))}
      </div>
      <p>
        選択期間：{hours === 168 ? "7日" : `${hours}時間`}
        {span !== hours * 3600 || anchor != null ? "（表示範囲を操作中）" : ""}
      </p>
      {c.length ? (
        <>
          <p aria-label="実際の表示期間">
            表示期間：{chartTime(start)} ～ {chartTime(finish)}（日本時間）
          </p>
          <p>
            表示範囲：{number((finish - start) / 3600, 2)}時間 ／ {c.length}
            本。開始は最初の足の開始、終了は最後の足の終了です。
          </p>
        </>
      ) : (
        <p role="status">
          期間を取得できません。表示可能なローソク足がありません。未取得の場合は次の画面更新を待ってください。
        </p>
      )}
      {data.candles.length > 0 && available < hours * 3600 && (
        <p className="chart-warning" role="status">
          データ不足：選択した期間の全データはありません。取得済みの最大
          {number(available / 3600, 2)}
          時間の範囲で表示します。追加のAPI取得は行いません。
        </p>
      )}
      {data.candles.length > 0 && (
        <>
          <div
            className="chart-controls"
            role="group"
            aria-label="チャート操作"
          >
            <button onClick={() => zoom(1 / 1.5)}>拡大</button>
            <button onClick={() => zoom(1.5)}>縮小</button>
            <button
              onClick={() => move(-Math.min(span, available) / 2)}
              disabled={end - Math.min(span, available) <= first}
            >
              過去へ
            </button>
            <button
              onClick={() => move(Math.min(span, available) / 2)}
              disabled={end >= latestEnd}
            >
              新しい方へ
            </button>
            <button
              onClick={() => {
                setAnchor(undefined);
                setSelected(null);
              }}
            >
              最新データへ戻る
            </button>
          </div>
        </>
      )}
      {c.length > 0 && (
        <>
          <p className="chart-help">
            横ドラッグで移動、Ctrl＋ホイールで拡大・縮小。キーボードではグラフにフォーカスし、左右キーで移動、＋／−で拡大・縮小、Homeで最新へ。時刻は日本時間です。
          </p>
          <svg
            ref={svg}
            className="interactive-price-chart"
            viewBox={`0 0 ${w} ${h}`}
            role="img"
            aria-label="価格チャート"
            tabIndex={0}
            onKeyDown={(e) => {
              if (
                ["ArrowLeft", "ArrowRight", "+", "=", "-", "Home"].includes(
                  e.key,
                )
              ) {
                e.preventDefault();
                if (e.key === "Home") setAnchor(undefined);
                else if (e.key === "ArrowLeft" || e.key === "ArrowRight")
                  move(
                    ((e.key === "ArrowLeft" ? -1 : 1) *
                      Math.min(span, available)) /
                      2,
                  );
                else zoom(e.key === "-" ? 1.5 : 1 / 1.5);
              }
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              drag.current = {
                x: e.clientX,
                y: e.clientY,
                end,
                span: Math.min(span, available),
                moved: false,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
              pick(e.clientX);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) {
                if (e.pointerType === "mouse") pick(e.clientX);
                return;
              }
              if (Math.abs(e.clientX - d.x) > 6) {
                d.moved = true;
                setAnchor(
                  Math.min(
                    latestEnd,
                    Math.max(
                      first + d.span,
                      d.end - ((e.clientX - d.x) / plot) * d.span,
                    ),
                  ),
                );
              }
            }}
            onPointerUp={(e) => {
              if (!drag.current?.moved) pick(e.clientX);
              drag.current = null;
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <text x="2" y="16" fill="#b0c1cf" fontSize="12">
              {number(max, 4)}
            </text>
            <text x="2" y="232" fill="#b0c1cf" fontSize="12">
              {number(min, 4)}
            </text>
            {c.map((b) => (
              <g
                key={b.timestamp}
                stroke={b.close >= b.open ? "#43dfb2" : "#f77d8f"}
              >
                <title>
                  {chartTime(b.timestamp)} {origin(b)}
                </title>
                <line
                  x1={x(b.timestamp + tf / 2)}
                  x2={x(b.timestamp + tf / 2)}
                  y1={y(b.high)}
                  y2={y(b.low)}
                />
                <rect
                  x={x(b.timestamp + tf / 2) - dx / 2}
                  width={dx}
                  y={y(Math.max(b.open, b.close))}
                  height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
                  fill={b.close >= b.open ? "#43dfb2" : "#f77d8f"}
                  strokeDasharray={
                    (b.timestamp + tf) * 1000 > Date.now()
                      ? "4 2"
                      : reconstructed(b)
                        ? "2 2"
                        : undefined
                  }
                />
                {(reconstructed(b) ||
                  (b.timestamp + tf) * 1000 > Date.now()) && (
                  <text
                    x={x(b.timestamp + tf / 2)}
                    y="28"
                    textAnchor="middle"
                    fill="#edc980"
                    fontSize="10"
                  >
                    {(b.timestamp + tf) * 1000 > Date.now() ? "○" : "◇"}
                  </text>
                )}
              </g>
            ))}
            {[visible.ema20, visible.ema50].map((set, j) => (
              <polyline
                key={j}
                aria-label={j === 0 ? "EMA20" : "EMA50"}
                fill="none"
                stroke={["#64b5ff", "#edc980"][j]}
                strokeWidth="1.8"
                points={set
                  .flatMap((v, i) =>
                    v == null ? [] : [`${x(c[i].timestamp + tf / 2)},${y(v)}`],
                  )
                  .join(" ")}
              />
            ))}
            {trades.map((t) => {
              const b = c.find(
                (b) =>
                  t.timestamp / 1000 >= b.timestamp &&
                  t.timestamp / 1000 < b.timestamp + tf,
              );
              return !b ? null : (
                <text
                  key={t.orderId}
                  x={x(b.timestamp + tf / 2)}
                  y={y(b.close) - 10}
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
            {chosen && (
              <line
                x1={x(chosen.timestamp + tf / 2)}
                x2={x(chosen.timestamp + tf / 2)}
                y1="30"
                y2="215"
                stroke="#b0c1cf"
                strokeDasharray="3 3"
              />
            )}
            {chartTicks(c, plot).map((t, i, ticks) => (
              <text
                key={t.timestamp}
                x={x(t.timestamp)}
                y="265"
                fill="#b0c1cf"
                textAnchor={
                  i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"
                }
                fontSize="12"
              >
                {t.label}
              </text>
            ))}
          </svg>
          <p className="chart-help">
            EMA20（青）／ EMA50（黄）／ ◇ 再構築足、○
            未確定足。データのない時間帯は空白で表示します。
          </p>
          {chosen && (
            <div className="candle-detail" aria-label="選択したローソク足">
              <label>
                ローソク足を選択
                <input
                  aria-label="ローソク足を選択"
                  type="range"
                  min={0}
                  max={c.length - 1}
                  value={c.indexOf(chosen)}
                  onChange={(e) =>
                    setSelected(c[Number(e.target.value)].timestamp)
                  }
                />
              </label>
              <h4>ローソク足の詳細（日本時間）</h4>
              <p>
                開始：{dateTime(chosen.timestamp * 1000)}
                <br />
                終了：{dateTime((chosen.timestamp + tf) * 1000)}
              </p>
              <p>
                {(chosen.timestamp + tf) * 1000 <= Date.now()
                  ? "確定済み"
                  : "未確定（更新する可能性があります）"}{" "}
                · {origin(chosen)}
              </p>
              <dl>
                {[
                  ["始値（Open）", chosen.open],
                  ["高値（High）", chosen.high],
                  ["安値（Low）", chosen.low],
                  ["終値（Close）", chosen.close],
                  [
                    "出来高",
                    Number.isFinite(chosen.volume) ? chosen.volume : null,
                  ],
                ].map(([name, value]) => (
                  <React.Fragment key={name}>
                    <dt>{name}</dt>
                    <dd>{value == null ? "未取得" : number(value, 6)}</dd>
                  </React.Fragment>
                ))}
              </dl>
              <p>取得元：{chosen.source || "未取得"}</p>
              {chosen.provenance && (
                <p>
                  取得時刻：{dateTime(chosen.provenance.fetchedAt)} ／ 根拠：
                  {chosen.provenance.evidence.join("、") || "記録なし"}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
