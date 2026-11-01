import { chartGapQuality } from "../../../packages/shared/src/chart-gap-quality.ts";
import { candleGeometry } from "./candleGeometry.ts";
import { chartForecast, FORECAST_BARS } from "./chartForecast.ts";
import { IndicatorPanel } from "./IndicatorPanel.tsx";
import { chartSeries, lineSegments } from "./chartIndicators.ts";
import type { SettingsApi } from "./settingsPresets.ts";
import type { HistoryResult } from "../../worker/src/chart-history.ts";
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
  pair = "SUI_USDC",
  candles,
  trades,
  timeframe = 300,
  synchronized = false,
  historyApi,
}: {
  pair?: ReturnType<BotEngine["snapshot"]>["pair"];
  candles: Candle[];
  trades: ReturnType<BotEngine["snapshot"]>["trades"];
  timeframe?: number;
  synchronized?: boolean;
  historyApi?: SettingsApi;
}) {
  const [gapTime, setGapTime] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryResult | null>(null),
    [historyBusy, setHistoryBusy] = useState(false),
    [historyNotice, setHistoryNotice] = useState("");
  const input = useMemo(() => {
    if (!history) return candles;
    const merged = new Map(history.candles.map((c) => [c.timestamp, c]));
    for (const c of candles)
      if (c.source.startsWith(`DeepBook:${pair}:USDC`))
        merged.set(c.timestamp, c);
    return [...merged.values()];
  }, [candles, history, pair]);
  const data = useMemo(() => chartData(input), [input]);
  const seriesKey = useMemo(
    () =>
      JSON.stringify(
        data.candles.map((c) => [c.timestamp, c.timeframe, c.close]),
      ),
    [data],
  );
  const series = useMemo(() => chartSeries(data.candles), [seriesKey]);
  const indexes = useMemo(
    () => new Map(data.candles.map((c, i) => [c.timestamp, i])),
    [data],
  );
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
  // Model outlook (next FORECAST_BARS candles) — only in the
  // latest view; panning into the past hides it. Display only:
  // it never feeds the bot or the indicators.
  const fc = useMemo(
    () => (anchor == null ? chartForecast(data.candles) : null),
    [data, anchor],
  );
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
  const gapQuality = useMemo(
    () => chartGapQuality(c, start, finish, tf),
    [visible, tf],
  );
  const selectedGap = gapQuality.entries.find((g) => g.timestamp === gapTime);
  const xFinish = fc ? latestEnd + FORECAST_BARS * tf : finish;
  const x = (t: number) => left + ((t - start) / (xFinish - start)) * plot;
  const values = [
    ...c.flatMap((b) => [b.low, b.high]),
    ...visible.ema20,
    ...visible.ema50,
    ...(fc ? fc.points.flatMap((p) => [p.lower, p.upper]) : []),
  ].filter((v): v is number => v != null);
  const min = Math.min(...values),
    max = Math.max(...values),
    y = (v: number) => 215 - ((v - min) / (max - min || 1)) * 180;
  const dx = Math.max(0.8, Math.min(24, (plot / (xFinish - start)) * tf * 0.6));
  const fcAnchor =
    fc && latest
      ? `${x(latest.timestamp + tf / 2)},${y(latest.close)}`
      : null;
  const fcMid = fc
    ? [
        fcAnchor!,
        ...fc.points.map(
          (p) => `${x(p.timestamp + tf / 2)},${y(p.mid)}`,
        ),
      ].join(" ")
    : null;
  const fcCone = fc
    ? [
        fcAnchor!,
        ...fc.points.map(
          (p) => `${x(p.timestamp + tf / 2)},${y(p.upper)}`,
        ),
        ...[...fc.points]
          .reverse()
          .map((p) => `${x(p.timestamp + tf / 2)},${y(p.lower)}`),
      ].join(" ")
    : null;
  const geometry = useMemo(
    () => candleGeometry(c, x, y, dx),
    [visible, w, min, max, tf],
  );
  const chosen = c.find((b) => b.timestamp === selected) ?? c.at(-1);
  const pick = (clientX: number) => {
    if (!svg.current || !c.length) return;
    const rect = svg.current.getBoundingClientRect(),
      t =
        start +
        ((((clientX - rect.left) / rect.width) * w - left) / plot) *
          (xFinish - start);
    const nearest = c.reduce((a, b) =>
      Math.abs(b.timestamp + tf / 2 - t) < Math.abs(a.timestamp + tf / 2 - t)
        ? b
        : a,
    );
    setSelected(nearest.timestamp);
  };
  const loadHistory = async () => {
    if (!historyApi || historyBusy) return;
    setHistoryBusy(true);
    setHistoryNotice("");
    const to = Math.floor(Date.now() / 1000 / tf) * tf,
      from = to - 7 * 86400 - 120 * tf;
    try {
      const raw = (await historyApi(
        `chart/history?timeframe=${tf}&from=${from}&to=${to}`,
      )) as HistoryResult;
      if (
        !Array.isArray(raw.candles) ||
        raw.timeframe !== tf ||
        raw.candles.some((c) => !c.source.startsWith(`DeepBook:${pair}:USDC`))
      )
        throw Error("INVALID_CHART_HISTORY");
      setHistory(raw);
      setHistoryNotice(
        `表示専用履歴（準備用の過去足を含む）：${raw.candles.length}本取得 ／ 欠損${raw.missing}本${raw.error ? ` ／ 取得未完了（${raw.error}）。市場データ取得を優先しています。後で手動で再取得してください。` : ""}`,
      );
      choosePeriod(168);
    } catch {
      setHistoryNotice(
        "履歴を取得できません。取得済みの表示を維持します。後で手動で再取得してください。",
      );
    } finally {
      setHistoryBusy(false);
    }
  };
  const visibleSeries = (key: keyof typeof series) =>
    c.map((b) => series[key][indexes.get(b.timestamp)!]);
  const interactions: React.SVGProps<SVGSVGElement> = {
    onKeyDown: (e) => {
      if (["ArrowLeft", "ArrowRight", "+", "=", "-", "Home"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "Home") setAnchor(undefined);
        else if (e.key === "ArrowLeft" || e.key === "ArrowRight")
          move(
            ((e.key === "ArrowLeft" ? -1 : 1) * Math.min(span, available)) / 2,
          );
        else zoom(e.key === "-" ? 1.5 : 1 / 1.5);
      }
    },
    onPointerDown: (e) => {
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
    },
    onPointerMove: (e) => {
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
    },
    onPointerUp: (e) => {
      if (!drag.current?.moved) pick(e.clientX);
      drag.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
    },
    onPointerCancel: () => {
      drag.current = null;
    },
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
    <div
      className="price-chart"
      ref={host}
      aria-label={`${pair.replace("_", "/")}価格表示`}
    >
      <p>
        <strong>
          {pair.replace("_", " / ")} · {tf / 60}分足
        </strong>
      </p>
      {fc && (
        <p className="chart-forecast-note">
          予測（模式）：この先{FORECAST_BARS}本（
          {number((FORECAST_BARS * tf) / 3600, 1)}
          時間）の見通しは{fc.directionWord}、振れ幅 ±
          {number(fc.bandPct * 100, 1)}
          %。トレンドと値幅（ATR）から伸ばしたもので、実際の価格ではありません。
        </p>
      )}
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
      {historyApi && (
        <div className="chart-history">
          <button disabled={historyBusy} onClick={() => void loadHistory()}>
            {historyBusy ? "履歴取得中…" : "DeepBookの7日履歴を取得"}
          </button>
          <p role="status">{historyNotice}</p>
          <small>
            表示専用のDeepBook市場履歴です。Botの市場データ・判断は変更しません。履歴は10秒ごとに再取得しません。
          </small>
        </div>
      )}
      <p>
        選択期間：{hours === 168 ? "7日" : `${hours}時間`}
        {span !== hours * 3600 || anchor != null ? "（表示範囲を操作中）" : ""}
      </p>
      {c.length ? (
        <>
          <p aria-label="実際の表示期間">
            表示期間：{chartTime(start)} ～ {chartTime(xFinish)}（日本時間）
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
      {c.length > 0 && (finish - start) / tf > c.length && (
        <p className="chart-warning">
          表示期間内の欠損：{Math.round((finish - start) / tf - c.length)}
          本。未取得部分を補間せず、指標の準備が不足する区間は未計測です。
        </p>
      )}
      {c.length > 0 && (
        <div aria-label="表示履歴の品質">
          <p>
            期待：{gapQuality.expected}本 ／ 取得済み：{gapQuality.received}本
            ／ 欠損：{gapQuality.missing}本 ／ 検証済み再構築：
            {gapQuality.reconstructed}本 ／ 原因未確定：{gapQuality.unknown}本
          </p>
          {gapQuality.entries.length > 0 && (
            <>
              <label>
                欠損・再構築の日時
                <select
                  aria-label="欠損・再構築の日時"
                  value={gapTime ?? ""}
                  onChange={(e) =>
                    setGapTime(e.target.value ? Number(e.target.value) : null)
                  }
                >
                  <option value="">日時を選択</option>
                  {gapQuality.entries.map((g) => (
                    <option key={g.timestamp} value={g.timestamp}>
                      {chartTime(g.timestamp)}（日本時間）
                      {g.reconstructed ? "・再構築" : "・欠損"}
                    </option>
                  ))}
                </select>
              </label>
              {selectedGap && (
                <p role="status">
                  対象日時：{dateTime(selectedGap.timestamp * 1000)} ／{" "}
                  {selectedGap.reason}（{selectedGap.cause}） ／{" "}
                  {selectedGap.reconstructed
                    ? "検証済み再構築データ"
                    : "補完せず欠損を維持"}
                  。公式Indexerでの照合範囲です。
                </p>
              )}
            </>
          )}
        </div>
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
            {...interactions}
          >
            <text x="2" y="16" fill="#b0c1cf" fontSize="12">
              {number(max, 4)}
            </text>
            <text x="2" y="232" fill="#b0c1cf" fontSize="12">
              {number(min, 4)}
            </text>
            {geometry.groups.map((g) => (
              <g key={g.color + g.style}>
                <path d={g.wick} fill="none" stroke={g.color} />
                <path
                  d={g.body}
                  fill={g.color}
                  stroke={g.color}
                  strokeDasharray={
                    g.style === "provisional"
                      ? "4 2"
                      : g.style === "reconstructed"
                        ? "2 2"
                        : undefined
                  }
                />
              </g>
            ))}
            {geometry.markers.map((m, i) => (
              <text
                key={i}
                x={m.x}
                y="28"
                textAnchor="middle"
                fill="#edc980"
                fontSize="10"
              >
                {m.symbol}
              </text>
            ))}
            {[visibleSeries("ema20"), visibleSeries("ema50")].map((set, j) => (
              <g key={j} aria-label={j === 0 ? "EMA20" : "EMA50"}>
                {lineSegments(c, set, x, y).map((points, i) => (
                  <polyline
                    key={i}
                    aria-label={j === 0 ? "EMA20" : "EMA50"}
                    fill="none"
                    stroke={["#64b5ff", "#edc980"][j]}
                    strokeWidth="1.8"
                    points={points}
                  />
                ))}
              </g>
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
            {fc && fcCone && fcMid && (
              <g className="chart-forecast" aria-label="予測（模式）">
                <line
                  x1={x(latestEnd)}
                  x2={x(latestEnd)}
                  y1="30"
                  y2="215"
                  stroke="#64b5ff"
                  strokeDasharray="2 4"
                  opacity="0.6"
                />
                <polygon points={fcCone} fill="rgba(100,181,255,0.10)" />
                <polyline
                  points={fcMid}
                  fill="none"
                  stroke="#64b5ff"
                  strokeWidth="1.6"
                  strokeDasharray="5 4"
                />
                <text
                  x={x(fc.points.at(-1)!.timestamp + tf / 2)}
                  y={y(fc.points.at(-1)!.mid) - 8}
                  textAnchor="end"
                  fill="#64b5ff"
                  fontSize="11"
                >
                  予測
                </text>
              </g>
            )}
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
          {synchronized && (
            <>
              <p>
                選択日時：{chosen ? chartTime(chosen.timestamp) : "未選択"}
                （足の開始・日本時間）
              </p>
              <IndicatorPanel
                interaction={interactions}
                onZoom={zoom}
                kind="RSI"
                candles={c}
                sets={[visibleSeries("rsi")]}
                width={w}
                start={start}
                end={xFinish}
                selected={chosen?.timestamp ?? null}
              />
              <IndicatorPanel
                interaction={interactions}
                onZoom={zoom}
                kind="MACD"
                candles={c}
                sets={[
                  visibleSeries("macd"),
                  visibleSeries("signal"),
                  visibleSeries("histogram"),
                ]}
                width={w}
                start={start}
                end={xFinish}
                selected={chosen?.timestamp ?? null}
              />
            </>
          )}
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
