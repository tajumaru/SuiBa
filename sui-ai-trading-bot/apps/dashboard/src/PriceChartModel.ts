import { chartGapQuality } from "../../../packages/shared/src/chart-gap-quality.ts";
import { candleHoverLines } from "./chartHover.ts";
import {
  answerGhost,
  crossingMarksFor,
  forecastGeometry,
} from "./chartOverlayGeometry.ts";
import { candleGeometry } from "./candleGeometry.ts";
import { chartForecast, FORECAST_BARS } from "./chartForecast.ts";
import type { ForecastAnswerCheck } from "./forecastLog.ts";
import { chartSeries } from "./chartIndicators.ts";
import type { SettingsApi } from "./settingsPresets.ts";
import type { HistoryResult } from "../../worker/src/chart-history.ts";
import { useMemo, useState, useEffect, useRef } from "react";
import type { Candle } from "../../../packages/shared/src/index.ts";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import { chartData, chartWindow } from "./chartPresentation.ts";
import type { ShareCardInput } from "./shareCard.ts";

export interface PriceChartProps {
  pair?: BotSnapshot["pair"];
  candles: Candle[];
  trades: BotSnapshot["trades"];
  timeframe?: number;
  synchronized?: boolean;
  historyApi?: SettingsApi;
  forecastScoreText?: string | null;
  /** Live status of the newest touch target, if one is open. */
  forecastTouchText?: string | null;
  /** Learned cone-width scale (forecastCalib); the drawn cone
   * and the recorded one must use the same scale. */
  forecastBandScale?: number;
  bookImbalance?: number | null;
  /** The open position's real sell lines (same prices the
   * ticker counts down to), for forecast crossing marks. */
  sellLines?: { tp: number; sl: number } | null;
  /** The newest finished forecast, for the answer-check view
   * (the recorded cone laid over what actually happened). */
  answerCheck?: ForecastAnswerCheck | null;
  answerDefaultOn?: boolean;
  /** Everything the share card needs, assembled by the shell
   * from the live forecast and the recorded score. */
  shareCard?: ShareCardInput | null;
}

export function usePriceChartModel({
  pair = "SUI_USDC",
  candles,
  trades,
  timeframe = 300,
  synchronized = false,
  historyApi,
  forecastScoreText,
  forecastTouchText,
  forecastBandScale = 1,
  bookImbalance,
  sellLines,
  answerCheck,
  answerDefaultOn = false,
  shareCard,
}: PriceChartProps) {
  const [gapTime, setGapTime] = useState<number | null>(null);
  const [answerOn, setAnswerOn] = useState(answerDefaultOn);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareNote, setShareNote] = useState("");
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
    () =>
      anchor == null
        ? chartForecast(
            data.candles,
            FORECAST_BARS,
            bookImbalance ?? null,
            forecastBandScale,
          )
        : null,
    [data, anchor, bookImbalance, forecastBandScale],
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
    [visible, tf, c, start, finish],
  );
  const selectedGap = gapQuality.entries.find((g) => g.timestamp === gapTime);
  const xFinish = fc ? latestEnd + FORECAST_BARS * tf : finish;
  const x = (t: number) => left + ((t - start) / (xFinish - start)) * plot;
  // The answer-check view exists only in the latest 5-minute
  // view, like the forecast itself (its records are 5-minute).
  const showAnswer =
    answerOn && answerCheck != null && anchor == null && tf === 300;
  const values = [
    ...c.flatMap((b) => [b.low, b.high]),
    ...visible.ema20,
    ...visible.ema50,
    ...(fc ? fc.points.flatMap((p) => [p.lower, p.upper]) : []),
    ...(showAnswer
      ? answerCheck.points.flatMap((p) => [p.lower, p.upper])
      : []),
  ].filter((v): v is number => v != null);
  const min = Math.min(...values),
    max = Math.max(...values),
    y = (v: number) => 215 - ((v - min) / (max - min || 1)) * 180;
  const dx = Math.max(0.8, Math.min(24, (plot / (xFinish - start)) * tf * 0.6));
  const fcGeom = fc ? forecastGeometry(fc, latest, x, y, tf) : null;
  const fcMid = fcGeom?.mid ?? null,
    fcCone = fcGeom?.cone ?? null,
    fcPalette = fcGeom?.palette ?? null,
    fcLabel = fcGeom?.label ?? null;
  // Answer-check geometry: the recorded cone (ghost) over the
  // bars that actually followed it, with the real closes as a
  // solid white line — dotted was the claim, solid is the fact.
  const ghost = showAnswer ? answerGhost(answerCheck, x, y, tf) : null;
  // Where the outlook meets the position's sell lines, if it
  // does: geometry over the sketch, labelled as such in place.
  const crossingMarks =
    fc && sellLines ? crossingMarksFor(fc, sellLines, x, y, tf) : [];
  const geometry = useMemo(
    () => candleGeometry(c, x, y, dx),
    [visible, w, min, max, tf],
  );
  const chosen = c.find((b) => b.timestamp === selected) ?? c.at(-1);
  // Above-chart readout for the hovered/tapped candle. Only while
  // a candle is actually selected — the default "latest" state
  // keeps the chart clean.
  const hoverLines =
    selected != null && chosen ? candleHoverLines(chosen) : null;
  const hoverCx = chosen ? x(chosen.timestamp + tf / 2) : 0;
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
  const origin = (b: Candle) =>
    !b.provenance
      ? "再構築情報なし"
      : b.provenance.origin === "ORIGINAL"
        ? "元データ"
        : b.provenance.origin === "ONE_MINUTE_AGGREGATE"
          ? "再構築（確定1分足から集約）"
          : "再構築（無約定確認済み）";
  return {
    pair,
    trades,
    forecastScoreText,
    forecastTouchText,
    shareCard,
    answerCheck,
    historyApi,
    synchronized,
    tf,
    fc,
    shareBusy,
    shareNote,
    answerOn,
    historyBusy,
    historyNotice,
    hours,
    c,
    start,
    finish,
    xFinish,
    data,
    available,
    gapQuality,
    gapTime,
    selectedGap,
    end,
    first,
    latestEnd,
    span,
    interactions,
    svg,
    host,
    w,
    h,
    left,
    right,
    min,
    max,
    geometry,
    visibleSeries,
    x,
    y,
    ghost,
    crossingMarks,
    fcCone,
    fcMid,
    fcPalette,
    fcLabel,
    chosen,
    hoverLines,
    hoverCx,
    zoom,
    move,
    loadHistory,
    setShareBusy,
    setShareNote,
    setAnswerOn,
    setGapTime,
    setAnchor,
    setSelected,
    origin,
    choosePeriod,
    anchor,
    plot,
  };
}
