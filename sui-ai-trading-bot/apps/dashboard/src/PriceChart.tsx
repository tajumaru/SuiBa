import { forecastPalette } from "./chartForecast.ts";

// Kept as a re-export: the palette's home is chartForecast.ts
// (shared with the share card), and existing imports name this
// module.
export { forecastPalette };
import { candleHoverLines } from "./chartHover.ts";

// Kept as a re-export: the hover readout's home is chartHover.ts,
// and existing imports (and tests) name this module.
export { candleHoverLines };
import { IndicatorPanel } from "./IndicatorPanel.tsx";
import { lineSegments } from "./chartIndicators.ts";
import React from "react";
import { chartPeriods, chartTime, chartTicks } from "./chartPresentation.ts";
import { number, dateTime, label } from "./presentation.ts";
import { usePriceChartModel, type PriceChartProps } from "./PriceChartModel.ts";
import {
  AnswerGhostOverlay,
  AnswerDetails,
  BuyLineOverlay,
  ForecastOverlay,
  ForecastDetails,
  HoverReadout,
  HoverMarker,
} from "./PriceChartOverlays.tsx";

export function PriceChart(props: PriceChartProps) {
  const {
    pair,
    trades,
    forecastScoreText,
    forecastTouchText,
    answerCheck,
    historyApi,
    synchronized,
    tf,
    fc,
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
    linePrice,
    oversold,
    fcCone,
    fcPalette,
    fcLabel,
    chosen,
    hoverLines,
    hoverCx,
    zoom,
    move,
    loadHistory,
    setAnswerOn,
    setGapTime,
    setAnchor,
    setSelected,
    origin,
    choosePeriod,
    anchor,
    plot,
  } = usePriceChartModel(props);
  const markerRows = new Map<string, number>();
  const viewingAdjusted = span !== hours * 3600 || anchor != null;
  const displayMissing = c.length
    ? Math.max(0, Math.round((finish - start) / tf - c.length))
    : 0;
  const periodText = hours === 168 ? "7日" : `${hours}時間`;
  const signedPct = (value: number) =>
    `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
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
          この先{number((fc.points.length * tf) / 3600, 1)}時間の目安：
          {fc.directionWord}、動きは ±{number(fc.bandPct * 100, 1)}
          % くらい。計算で出した目安で、実際の価格ではありません。
          {fc.bookTiltPct !== 0 &&
            `${fc.bookTiltPct > 0 ? "買い" : "売り"}板が厚めなのも少し加味。`}
          {fc.touch && `タッチラインの確率は、過去の似た予測が当たった割合です。`}
        </p>
      )}
      {fc && tf === 300 && forecastScoreText && (
        <p className="chart-forecast-score">{forecastScoreText}</p>
      )}
      {fc && tf === 300 && forecastTouchText && (
        <p className="chart-forecast-touch-status">{forecastTouchText}</p>
      )}
      {tf === 300 && answerCheck && (
        <div className="chart-answer-row">
          <button
            type="button"
            className="chart-answer-toggle"
            aria-pressed={answerOn}
            onClick={() => setAnswerOn((v) => !v)}
          >
            前の予測と実際を比較
          </button>
          {answerOn && (
            <p
              className={`chart-answer-verdict${
                answerCheck.directionHit == null
                  ? ""
                  : answerCheck.directionHit
                    ? " hit"
                    : " miss"
              }`}
            >
              予測 {signedPct(answerCheck.driftPct)} → 実際{" "}
              {signedPct(answerCheck.actualPct)}／範囲内{" "}
              {answerCheck.coveragePct}%
              <span className="chart-answer-tag">
                {answerCheck.directionHit == null
                  ? "判定なし"
                  : answerCheck.directionHit
                    ? "当たり"
                    : "外れ"}
              </span>
            </p>
          )}
        </div>
      )}
      <div
        className="chart-period-segments"
        role="group"
        aria-label="表示期間の選択"
      >
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
          <button
            className="chart-history-button"
            disabled={historyBusy}
            onClick={() => void loadHistory()}
          >
            {historyBusy ? "履歴取得中…" : "DeepBookの7日履歴を取得"}
          </button>
          <p className="chart-meta" role="status">
            {historyNotice}
          </p>
          <small>
            表示専用のDeepBook市場履歴です。Botの市場データ・判断は変更しません。履歴は10秒ごとに再取得しません。
          </small>
        </div>
      )}
      {c.length ? (
        <p className="chart-meta chart-status-line" aria-label="実際の表示期間">
          {periodText}・{c.length}本（欠損{displayMissing}）
          {gapQuality.reconstructed > 0 &&
            `・検証済み再構築${gapQuality.reconstructed}本`}
          {gapQuality.unknown > 0 && `・原因未確定${gapQuality.unknown}本`}
          {viewingAdjusted && "・表示範囲を操作中"}
          <span className="sr-only">
            表示期間：{chartTime(start)} ～ {chartTime(xFinish)}（日本時間）
          </span>
        </p>
      ) : (
        <p className="chart-meta" role="status">
          期間を取得できません。表示可能なローソク足がありません。未取得の場合は次の画面更新を待ってください。
        </p>
      )}
      {data.candles.length > 0 && available < hours * 3600 && (
        <p className="chart-warning chart-meta" role="status">
          データ不足：選択した期間の全データはありません。取得済みの最大
          {number(available / 3600, 2)}
          時間の範囲で表示します。追加のAPI取得は行いません。
        </p>
      )}
      {c.length > 0 && (
        <div aria-label="表示履歴の品質">
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
                <p className="chart-meta" role="status">
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
            className="chart-controls chart-navigation"
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
            {viewingAdjusted && (
              <button
                className="chart-latest-button"
                onClick={() => {
                  setAnchor(undefined);
                  setSelected(null);
                }}
              >
                最新データへ戻る
              </button>
            )}
          </div>
        </>
      )}
      {c.length > 0 && (
        <>
          <p className="chart-help chart-operation-help">
            横ドラッグで移動、Ctrl＋ホイールで拡大・縮小。キーボードではグラフにフォーカスし、左右キーで移動、＋／−で拡大・縮小、Homeで最新へ。時刻は日本時間です。
          </p>
          <HoverReadout hoverLines={hoverLines} />
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
              if (!b) return null;
              const markerKey = `${b.timestamp}:${t.side}`;
              const row = markerRows.get(markerKey) ?? 0;
              markerRows.set(markerKey, row + 1);
              const buying = t.side === "BUY";
              return (
                <text
                  key={t.orderId}
                  x={x(b.timestamp + tf / 2)}
                  y={
                    buying ? y(b.low) + 18 + row * 14 : y(b.high) - 8 - row * 14
                  }
                  textAnchor="middle"
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
            {fc && fcCone && (
              <ForecastOverlay
                fc={fc}
                fcCone={fcCone}
                fcPalette={fcPalette!}
                crossingMarks={crossingMarks}
                x={x}
                y={y}
                latestEnd={latestEnd}
              />
            )}
            <BuyLineOverlay
              linePrice={linePrice}
              min={min}
              max={max}
              y={y}
              left={left}
              right={right}
            />
            {ghost && <AnswerGhostOverlay ghost={ghost} />}
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
            {hoverLines && chosen && (
              <HoverMarker
                chosen={chosen}
                hoverCx={hoverCx}
                y={y}
                left={left}
                right={right}
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
          {ghost && answerCheck && (
            <AnswerDetails check={answerCheck} ghost={ghost} timeframe={tf} />
          )}
          {fc && fcCone && (
            <ForecastDetails
              fc={fc}
              horizonHours={(fc.points.length * tf) / 3600}
              label={fcLabel}
              crossingMarks={crossingMarks}
            />
          )}
          <p className="chart-help">
            EMA20（青）／ EMA50（黄）／ ◇ 再構築足、○
            未確定足。データのない時間帯は空白で表示します。
          </p>
          {synchronized && (
            <>
              <p className="chart-meta">
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
                dataEnd={finish}
                selected={chosen?.timestamp ?? null}
                lineValue={oversold}
                lineLabel="買いライン"
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
                dataEnd={finish}
                selected={chosen?.timestamp ?? null}
              />
            </>
          )}
          {chosen && (
            <div
              className="candle-detail chart-meta"
              aria-label="選択したローソク足"
            >
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
              <p className="candle-note">
                取得元：
                {(chosen.source || "未取得")
                  .split(":")
                  .map((part, i, parts) => (
                    <React.Fragment key={i}>
                      <span className="candle-source-part">
                        {part}
                        {i < parts.length - 1 ? ":" : ""}
                      </span>
                      {i < parts.length - 1 && <wbr />}
                    </React.Fragment>
                  ))}
              </p>
              {chosen.provenance && (
                <p className="candle-note">
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
