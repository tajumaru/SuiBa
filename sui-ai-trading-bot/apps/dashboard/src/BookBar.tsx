import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion.ts";

/**
 * The DeepBook order book's lean for the current pair, as one
 * slim bar under the chain strip. The number is the same
 * imbalance that leans the model outlook (worker snapshot,
 * display only): within ±1% of the mid, how the bid and ask
 * notionals split. The bar grows from the centre — mint to
 * the right when bids outweigh asks, rose to the left when
 * asks outweigh bids. Renders nothing until a sample exists.
 */
export interface BookBarModel {
  /** Share of in-band notional on the bid side, 0..100. */
  bidPct: number;
  askPct: number;
  side: "buy" | "sell" | "even";
  sideWord: string;
  /** Bar fill from the centre, 0..50 (percent of the track). */
  fillPct: number;
}

export function bookBarModel(imbalance: number): BookBarModel {
  const v = Math.max(-1, Math.min(1, imbalance));
  const bidPct = Math.round(((1 + v) / 2) * 100);
  const side = v > 0.05 ? "buy" : v < -0.05 ? "sell" : "even";
  return {
    bidPct,
    askPct: 100 - bidPct,
    side,
    sideWord: side === "buy" ? "買い優勢" : side === "sell" ? "売り優勢" : "均衡",
    fillPct: Math.abs(v) * 50,
  };
}

const WAVE_RGB = { buy: "67,223,178", sell: "255,125,156" } as const;

/**
 * The fill as a small liquid: two translucent wave layers
 * sloshing inside the centre-out fill, drawn on a canvas.
 * The wave amplitude grows with the lean itself — near-calm
 * around even, rougher as the book leans harder — so the
 * motion carries the same number the length does, and the
 * fill eases toward new samples instead of jumping. Pure
 * decoration over the same value; the labels and the verdict
 * word stay the facts. Reduced motion draws one still frame.
 */
function BookWave({
  imbalance,
  side,
}: {
  imbalance: number;
  side: BookBarModel["side"];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const targetRef = useRef(imbalance);
  targetRef.current = imbalance;
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let w = 0,
      h = 0,
      raf = 0;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const d = window.devicePixelRatio || 1;
      w = Math.max(0, r.width);
      h = Math.max(0, r.height);
      canvas.width = Math.max(1, Math.round(w * d));
      canvas.height = Math.max(1, Math.round(h * d));
      ctx.setTransform(d, 0, 0, d, 0, 0);
    };
    resize();
    const draw = (t: number, v: number) => {
      ctx.clearRect(0, 0, w, h);
      const mid = w / 2,
        fillW = Math.abs(v) * mid;
      if (fillW < 1 || h < 4) return;
      const x0 = v >= 0 ? mid : mid - fillW;
      const x1 = v >= 0 ? mid + fillW : mid;
      const rgb = v >= 0 ? WAVE_RGB.buy : WAVE_RGB.sell;
      const amp = 0.5 + Math.abs(v) * 2.4;
      const surface = h * 0.38;
      for (const [phase, alpha] of [
        [0, 0.32],
        [2.2, 0.55],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(x0, h);
        for (let x = x0; x <= x1; x += 3) {
          const y =
            surface +
            Math.sin(x * 0.055 + t * 1.6 + phase) * amp * 0.6 +
            Math.sin(x * 0.11 - t * 2.3 + phase) * amp * 0.4;
          ctx.lineTo(x, Math.max(0.5, Math.min(h - 0.5, y)));
        }
        ctx.lineTo(x1, h);
        ctx.closePath();
        ctx.fillStyle = `rgba(${rgb},${alpha})`;
        ctx.fill();
      }
    };
    if (reduced) {
      draw(0.8, targetRef.current);
      return;
    }
    let shown = targetRef.current;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const target = Math.max(-1, Math.min(1, targetRef.current));
      shown += (target - shown) * Math.min(1, dt * 3.2);
      if (!document.hidden) draw(now / 1000, shown);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [reduced]);
  return (
    <canvas
      ref={canvasRef}
      className={`book-bar-wave ${side}`}
      aria-hidden="true"
    />
  );
}

export function BookBar({ imbalance }: { imbalance: number | null }) {
  if (imbalance == null || !Number.isFinite(imbalance)) return null;
  const m = bookBarModel(imbalance);
  const v = Math.max(-1, Math.min(1, imbalance));
  return (
    <div className="book-bar" aria-label="板の偏り">
      <span className="book-bar-label">板</span>
      <span className="book-bar-side sell">売り {m.askPct}%</span>
      <span className="book-bar-track" aria-hidden="true">
        <BookWave imbalance={v} side={m.side} />
        <span className="book-bar-center" />
      </span>
      <span className="book-bar-side buy">買い {m.bidPct}%</span>
      <strong className={`book-bar-word ${m.side}`}>{m.sideWord}</strong>
    </div>
  );
}
