import type { BookLevels } from "../../../packages/shared/src/index.ts";
import { bookDepthModel } from "./bookDepth.ts";

const quantityFormat = new Intl.NumberFormat("ja-JP", {
  maximumSignificantDigits: 6,
});

export function BookDepthChart({
  levels,
  base,
  formatPrice,
}: {
  levels: BookLevels | null;
  base: string;
  formatPrice: (price: number) => string;
}) {
  const model = bookDepthModel(levels);
  if (!model) return null;

  return (
    <div className="book-depth">
      <div className="book-depth-row">
        <span>累計数量 ({base})</span>
        <span>{quantityFormat.format(model.maxTotal)}</span>
      </div>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label="買い板と売り板の深度。中央の破線は中間価格"
      >
        <path
          d="M 0 99 H 100"
          stroke="var(--dim)"
          vectorEffect="non-scaling-stroke"
        />
        {(
          [
            ["buy", model.bids, "#43dfb2"],
            ["sell", model.asks, "#f77d8f"],
          ] as const
        ).map(([side, curve, color]) => (
          <g key={side}>
            <path d={curve.area} fill={color} fillOpacity="0.16" />
            <path
              d={curve.path}
              fill="none"
              stroke={color}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
        <path
          d="M 50 0 V 100"
          stroke="var(--dim)"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="book-depth-row">
        <span>0</span>
        <span>価格</span>
      </div>
      <div className="book-depth-row book-depth-totals">
        <span>
          買い {formatPrice(model.bestBid)}
          <br />計 {quantityFormat.format(model.bids.total)} {base}
        </span>
        <span>
          売り {formatPrice(model.bestAsk)}
          <br />計 {quantityFormat.format(model.asks.total)} {base}
        </span>
      </div>
    </div>
  );
}
