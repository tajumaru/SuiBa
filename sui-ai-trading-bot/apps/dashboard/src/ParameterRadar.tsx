import type { Settings } from "../../../packages/shared/src/index.ts";
import { number } from "./presentation.ts";

export interface RadarAxis {
  label: string;
  valueText: string;
  /** Where the value sits inside its configurable range, 0..1. */
  ratio: number;
}

export interface ParameterRadarView {
  axes: RadarAxis[];
  /** 速攻型 / 慎重型 / バランス型, from the shape of the settings. */
  type: string;
  comment: string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const span = (v: number, min: number, max: number) =>
  clamp01((v - min) / (max - min));

/** The one-line reading of a radar shape: the largest axis and
 *  the smallest axis, in plain words. Shared by both radars. */
function shapeComment(axes: RadarAxis[]): string {
  const sorted = [...axes].sort((a, b) => b.ratio - a.ratio);
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  const topText =
    top.ratio >= 0.95
      ? `${top.label}が上限いっぱい`
      : top.ratio >= 0.7
        ? `${top.label}が高め`
        : `${top.label}が一番大きく`;
  const bottomText =
    bottom.ratio <= 0.15
      ? `${bottom.label}は下限寄り`
      : bottom.ratio <= 0.35
        ? `${bottom.label}は控えめ`
        : `${bottom.label}が一番小さい`;
  return `${topText}で、${bottomText}な形。`;
}

/**
 * The radar view of the buy-side parameters: six settings, each
 * placed inside the range the settings schema allows (the same
 * bounds the form enforces), plus a type name derived from the
 * shape. Display only — nothing here feeds back into trading.
 *
 * Axis semantics: RSIの買い基準・確認の速さ・最大取引額 lean
 * aggressive as they grow; 連続本数 leans cautious as it grows,
 * while 日次損失上限・出来高上限 lean cautious as they shrink.
 * 確認の速さ is the one inverted axis: a shorter interval is a
 * longer reach.
 */
export function parameterRadarView(s: Settings): ParameterRadarView {
  const candles = s.emaGapShrinkCandles ?? 3;
  const rsi = span(s.oversold, 10, 45);
  const candleRatio = span(candles, 2, 10);
  const volume = span(s.maxVolumeChange, 0, 20);
  const speed = 1 - span(s.intervalMs, 30_000, 3_600_000);
  const order = span(s.maxOrder, 0, 10);
  const loss = span(s.dailyLossPct, 0, 0.01);
  const axes: RadarAxis[] = [
    { label: "RSIの買い基準", valueText: number(s.oversold), ratio: rsi },
    { label: "連続本数", valueText: `${number(candles)} 本`, ratio: candleRatio },
    { label: "出来高上限", valueText: `${number(s.maxVolumeChange)} 倍`, ratio: volume },
    { label: "確認の速さ", valueText: `${number(s.intervalMs / 1000)} 秒`, ratio: speed },
    { label: "最大取引額", valueText: `${number(s.maxOrder)} USDC`, ratio: order },
    { label: "日次損失上限", valueText: `${number(s.dailyLossPct * 100)} %`, ratio: loss },
  ];
  const attack = (rsi + speed + order) / 3;
  const guard = (candleRatio + (1 - loss) + (1 - volume)) / 3;
  const type =
    Math.abs(attack - guard) < 0.2
      ? "バランス型"
      : attack > guard
        ? "速攻型"
        : "慎重型";
  return { axes, type, comment: shapeComment(axes) };
}

/**
 * The radar view of the sell-side parameters, drawn in gold so
 * the two radars read as a pair (mint = getting in, gold =
 * getting out). The type follows how long the settings let a
 * position run: wide exits and a high overbought line mean the
 * bot holds on （粘り型）, tight ones mean it lets go early
 * （早抜け型）.
 *
 * Axis order puts the longest label （スリッページ上限） at the
 * bottom centre, where the chart has room for it.
 */
export function sellParameterRadarView(s: Settings): ParameterRadarView {
  const overbought = span(s.overbought, 55, 90);
  const takeProfit = span(s.takeProfitPct, 0, 0.3);
  const stopLoss = span(s.stopLossPct, 0, 0.1);
  const axes: RadarAxis[] = [
    { label: "買われすぎ", valueText: number(s.overbought), ratio: overbought },
    {
      label: "利確ライン",
      valueText: `${number(s.takeProfitPct * 100)} %`,
      ratio: takeProfit,
    },
    {
      label: "最低純利益",
      valueText: `${number(s.minNetProfitUsdc)} USDC`,
      ratio: span(s.minNetProfitUsdc, 0, 5),
    },
    {
      label: "スリッページ上限",
      valueText: `${number(s.maxSlippage * 100)} %`,
      ratio: span(s.maxSlippage, 0, 0.003),
    },
    {
      label: "最大保有比率",
      valueText: `${number(s.maxHoldingRatio * 100)} %`,
      ratio: span(s.maxHoldingRatio, 0, 0.2),
    },
    {
      label: "損切りライン",
      valueText: `${number(s.stopLossPct * 100)} %`,
      ratio: stopLoss,
    },
  ];
  const patience = (overbought + takeProfit + stopLoss) / 3;
  const type =
    patience >= 0.6 ? "粘り型" : patience <= 0.2 ? "早抜け型" : "バランス型";
  return { axes, type, comment: shapeComment(axes) };
}

const CX = 170;
const CY = 150;
const R = 105;
const LABELS: ReadonlyArray<{
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}> = [
  { x: 170, y: 24, anchor: "middle" },
  { x: 268, y: 88, anchor: "start" },
  { x: 268, y: 200, anchor: "start" },
  { x: 170, y: 274, anchor: "middle" },
  { x: 72, y: 200, anchor: "end" },
  { x: 72, y: 88, anchor: "end" },
];

function point(index: number, ratio: number): [number, number] {
  const angle = ((index * 60 - 90) * Math.PI) / 180;
  return [CX + R * ratio * Math.cos(angle), CY + R * ratio * Math.sin(angle)];
}

const hexPoints = (axes: RadarAxis[], scale: number) =>
  axes.map((_, i) => point(i, scale).join(",")).join(" ");

/** One radar card: a title, its type chip and the hexagon. */
function RadarCard({
  title,
  view,
  sell = false,
}: {
  title: string;
  view: ParameterRadarView;
  sell?: boolean;
}) {
  const shape = view.axes
    .map((axis, i) => point(i, axis.ratio).join(","))
    .join(" ");
  return (
    <section
      className={sell ? "param-radar param-radar-sell" : "param-radar"}
      aria-label={title}
    >
      <div className="param-radar-head">
        <h4>{title}</h4>
        <span className="param-radar-type">{view.type}</span>
      </div>
      <p className="param-radar-sub">
        いまの設定の形。軸は設定できる範囲の中で、どこに寄っているか。
      </p>
      <svg
        className="param-radar-chart"
        viewBox="0 0 340 300"
        role="img"
        aria-label={`${title}の形：${view.type}。${view.comment}`}
      >
        <g fill="none" className="param-radar-grid">
          <polygon points={hexPoints(view.axes, 1)} />
          <polygon points={hexPoints(view.axes, 0.66)} strokeDasharray="3 4" />
          <polygon points={hexPoints(view.axes, 0.33)} strokeDasharray="3 4" />
        </g>
        <g className="param-radar-spokes">
          {view.axes.map((_, i) => {
            const [x, y] = point(i, 1);
            return <line key={i} x1={CX} y1={CY} x2={x} y2={y} />;
          })}
        </g>
        <polygon points={shape} className="param-radar-shape" />
        <g className="param-radar-dots">
          {view.axes.map((axis, i) => {
            const [x, y] = point(i, axis.ratio);
            return <circle key={axis.label} cx={x} cy={y} r="3.5" />;
          })}
        </g>
        {view.axes.map((axis, i) => (
          <g key={axis.label}>
            <text
              className="param-radar-axis-name"
              x={LABELS[i].x}
              y={LABELS[i].y}
              textAnchor={LABELS[i].anchor}
            >
              {axis.label}
            </text>
            <text
              className="param-radar-axis-val"
              x={LABELS[i].x}
              y={LABELS[i].y + 14}
              textAnchor={LABELS[i].anchor}
            >
              {axis.valueText}
            </text>
          </g>
        ))}
      </svg>
      <p className="param-radar-foot">{view.comment}</p>
    </section>
  );
}

/**
 * The 買いパラメータ radar at the top of the strategy tab's
 * parameter panel: the shape of the buy-side settings.
 */
export function ParameterRadar({ settings }: { settings: Settings }) {
  return <RadarCard title="買いパラメータ" view={parameterRadarView(settings)} />;
}

/** The 売りパラメータ radar, in gold, under the buy radar. */
export function SellParameterRadar({ settings }: { settings: Settings }) {
  return (
    <RadarCard title="売りパラメータ" view={sellParameterRadarView(settings)} sell />
  );
}
