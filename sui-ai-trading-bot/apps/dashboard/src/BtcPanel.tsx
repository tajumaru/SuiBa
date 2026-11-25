import React from "react";
import { parseBtcShadowSummary } from "./btcSummary.ts";
import { changeTone, formatChangePct, sparklinePoints } from "./presentation.ts";

export const BTC_ORANGE = "#f7931a";

export function BtcMark() {
  return (
    <span className="btc-mark" style={{ backgroundColor: BTC_ORANGE, color: "#fff" }} aria-hidden="true">
      ₿
    </span>
  );
}

const chartWidth = 320;
const chartHeight = 56;

function dollars(value: number) {
  return `$${value.toLocaleString("en-US")}`;
}

export function BtcPanel({ summary }: { summary: { text: string } | null }) {
  if (!summary) return <p className="btc-panel-body">BTCの影の記録はまだ届いていません</p>;

  const { at, body, move } = parseBtcShadowSummary(summary.text);
  const points = move && sparklinePoints(move.pts, chartWidth, chartHeight, 25);
  const change = move ? move.chg24 / 100 : 0;
  return (
    <section className="btc-panel" aria-label="BTC">
      <h2><BtcMark /> BTC</h2>
      {move && (
        <>
          <div className="btc-panel-price">
            <span className="price-ticker-price">{dollars(move.price)}</span>
            <span className={`price-ticker-change ${changeTone(change)}`}>
              24時間 {formatChangePct(change).replace("-", "−")}
            </span>
          </div>
          {points && (
            <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="BTCの24時間の値動き">
              <polygon points={`0,${chartHeight} ${points} ${chartWidth},${chartHeight}`} fill="var(--mint)" opacity="0.12" />
              <polyline points={points} fill="none" stroke="var(--mint)" strokeWidth="1.8" />
            </svg>
          )}
          <div className="btc-panel-range">
            <span>高値 {dollars(move.hi)}</span>
            <span>安値 {dollars(move.lo)}</span>
          </div>
        </>
      )}
      <p className="btc-panel-body">{body}</p>
      <small>
        MemWal経由の参照表示
        {at && <> <time dateTime={at}>{at.slice(11, 16)}</time></>}
      </small>
    </section>
  );
}

/**
 * The BTC look-back for the overview's ふりかえり segment
 * (owner, 2026-11-26): in BTC mode the segment shows the
 * shadow's grading — decisions taken and how the +4h scores
 * came out — instead of SUI's trading trio (equity curve,
 * activity grass, monthly report), which is SUI's look-back
 * and reads as the wrong face under a BTC switch. The body
 * is the same MemWal summary the ticker panel shows; only
 * the place differs.
 */
export function BtcReviewCard({ summary }: { summary: { text: string } | null }) {
  if (!summary) return <p className="btc-panel-body">BTCの影の記録はまだ届いていません</p>;

  const { at, body } = parseBtcShadowSummary(summary.text);
  return (
    <section className="btc-panel" aria-label="BTCの影 ふりかえり">
      <h2><BtcMark /> BTCの影 ふりかえり</h2>
      <p className="btc-panel-body">{body}</p>
      <small>
        MemWal経由の参照表示
        {at && <> <time dateTime={at}>{at.slice(11, 16)}</time></>}
      </small>
    </section>
  );
}
