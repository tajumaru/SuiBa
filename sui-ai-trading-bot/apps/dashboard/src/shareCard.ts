/**
 * The forecast share card: a 1200×675 image for posting (X and
 * friends), rendered from the LIVE forecast — the last 48 real
 * candles, the current cone in its direction colour, the selected
 * character, and the recorded forecast score from this device.
 * The honesty notes travel with the card: the forecast is marked
 * 模式 (a schematic EMA+ATR projection) and the score is labelled
 * as this device's own record.
 *
 * The SVG builder is pure (string in, string out) so it is
 * unit-testable; only createShareCardPng touches the DOM, turning
 * the SVG into a PNG and handing it to the OS share sheet (or a
 * download where file sharing is unavailable).
 */

import type { Candle } from "../../../packages/shared/src/index.ts";
import {
  FORECAST_BARS,
  chartForecast,
  forecastPalette,
  type ChartForecast,
} from "./chartForecast.ts";
import {
  MIN_SCORED_RECORDS,
  type ForecastScore,
} from "./forecastLog.ts";
import { artworkFor } from "./AgentHeaderAvatar.tsx";
import { agentDisplayName } from "./agentName.ts";
import type { AgentCharacter } from "./agentCharacter.ts";

export interface ShareCardInput {
  /** "SUI / USDC" style pair label. */
  pairLabel: string;
  /** The most recent 5-minute candles (the assembly keeps 48). */
  candles: Candle[];
  forecast: ChartForecast;
  score: ForecastScore;
  /** The character's display name (custom name or its default). */
  displayName: string;
  /** Bundled asset URL of the character's normal artwork; the
   * browser layer resolves it to a data URL for the SVG. */
  characterImageSrc: string;
  /** Card creation time, epoch ms. */
  at: number;
}

/** Assemble the card input from the dashboard's live state, or
 * null while no forecast can be drawn. */
export function shareCardInputFor(args: {
  pair: string;
  candles: Candle[];
  bookImbalance?: number | null;
  score: ForecastScore;
  character: AgentCharacter;
  agentName: string;
  at: number;
}): ShareCardInput | null {
  if (args.candles.length < 2) return null;
  const forecast = chartForecast(
    args.candles,
    FORECAST_BARS,
    args.bookImbalance ?? null,
  );
  if (!forecast) return null;
  return {
    pairLabel: args.pair === "WAL_USDC" ? "WAL / USDC" : "SUI / USDC",
    candles: args.candles.slice(-48),
    forecast,
    score: args.score,
    displayName: agentDisplayName(args.agentName, args.character),
    characterImageSrc: artworkFor(args.character, "normal", false).main,
    at: args.at,
  };
}

const MINT = "#43dfb2";
const PINK = "#f77d8f";
const INK = "#e6f0f6";
const DIM = "#8fa3b0";
const GRID = "#1b2836";
const SANS = "sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const n1 = (v: number) => Math.round(v * 10) / 10;

/** The card as a standalone SVG document (1200×675). */
export function buildShareCardSvg(
  input: ShareCardInput,
  characterImageDataUrl: string,
): string {
  const { forecast, score } = input;
  const palette = forecastPalette(forecast.direction, "card");
  const hist = input.candles;
  const steps = forecast.points;
  const total = hist.length + steps.length;
  const x0 = 36,
    x1 = 790,
    y0 = 110,
    y1 = 600;
  const slot = (x1 - x0) / (total - 1);
  const x = (i: number) => x0 + slot * i;
  let mn = Infinity,
    mx = -Infinity;
  for (const c of hist) {
    mn = Math.min(mn, c.low);
    mx = Math.max(mx, c.high);
  }
  for (const p of steps) {
    mn = Math.min(mn, p.lower);
    mx = Math.max(mx, p.upper);
  }
  const pad = (mx - mn) * 0.06 || 1;
  mn -= pad;
  mx += pad;
  const y = (v: number) => y1 - ((v - mn) / (mx - mn)) * (y1 - y0);

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">`,
    `<rect width="1200" height="675" fill="#04070b"/>`,
    `<rect x="10" y="10" width="1180" height="655" fill="none" stroke="#1f5c46" stroke-width="2"/>`,
  );
  // Header.
  out.push(
    `<text x="36" y="58" font-family="${MONO}" font-size="34" fill="${MINT}">SuiBa</text>`,
    `<text x="172" y="56" font-family="${SANS}" font-size="24" font-weight="bold" fill="${INK}">${esc(input.pairLabel)} ・ 予測</text>`,
    `<text x="1164" y="50" text-anchor="end" font-family="${MONO}" font-size="19" fill="${DIM}">PAPER</text>`,
    `<text x="1164" y="76" text-anchor="end" font-family="${MONO}" font-size="15" fill="${DIM}">${esc(
      new Date(input.at).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    )} 時点</text>`,
  );
  // Grid.
  for (let g = 0; g < 6; g++) {
    const gy = n1(y0 + ((y1 - y0) * g) / 5);
    out.push(
      `<line x1="${x0}" y1="${gy}" x2="${x1}" y2="${gy}" stroke="${GRID}" stroke-width="1"/>`,
    );
  }
  // Real candles.
  const bodyW = Math.max(2, slot * 0.62);
  hist.forEach((c, i) => {
    const cx = n1(x(i));
    const col = c.close >= c.open ? MINT : PINK;
    out.push(
      `<line x1="${cx}" y1="${n1(y(c.high))}" x2="${cx}" y2="${n1(y(c.low))}" stroke="${col}" stroke-width="2"/>`,
      `<rect x="${n1(cx - bodyW / 2)}" y="${n1(y(Math.max(c.open, c.close)))}" width="${n1(bodyW)}" height="${n1(
        Math.max(1.5, Math.abs(y(c.open) - y(c.close))),
      )}" fill="${col}"/>`,
    );
  });
  // The forecast cone.
  const originX = n1(x(hist.length - 1) + slot / 2);
  const upPts = steps
    .map((p, i) => `${n1(x(hist.length + i))},${n1(y(p.upper))}`)
    .join(" ");
  const loPts = steps
    .map((p, i) => `${n1(x(hist.length + i))},${n1(y(p.lower))}`)
    .join(" ");
  const midPts = [
    `${n1(x(hist.length - 1))},${n1(y(hist[hist.length - 1].close))}`,
    ...steps.map(
      (p, i) => `${n1(x(hist.length + i))},${n1(y(p.mid))}`,
    ),
  ].join(" ");
  out.push(
    `<polygon points="${upPts} ${loPts.split(" ").reverse().join(" ")}" fill="${palette.fill}"/>`,
    `<polyline points="${upPts}" fill="none" stroke="${palette.stroke}" stroke-width="1.5" opacity="0.75"/>`,
    `<polyline points="${loPts}" fill="none" stroke="${palette.stroke}" stroke-width="1.5" opacity="0.75"/>`,
    `<polyline points="${midPts}" fill="none" stroke="${palette.stroke}" stroke-width="3" stroke-dasharray="7 6"/>`,
    `<line x1="${originX}" y1="${y0}" x2="${originX}" y2="${y1}" stroke="#64b5ff" stroke-width="1.5"/>`,
  );
  const drift = forecast.driftPct * 100;
  out.push(
    `<text x="${n1(originX + 10)}" y="140" font-family="${SANS}" font-size="25" font-weight="bold" fill="${palette.stroke}">予測 ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}%</text>`,
  );
  // Right column: character, verdict, recorded score.
  out.push(
    `<image href="${characterImageDataUrl}" x="856" y="96" width="252" height="252"/>`,
    `<rect x="856" y="96" width="252" height="252" fill="none" stroke="${GRID}" stroke-width="1"/>`,
    `<text x="856" y="392" font-family="${SANS}" font-size="25" font-weight="bold" fill="${INK}">${esc(input.displayName)}の予測</text>`,
  );
  const directionLine =
    forecast.direction === "up"
      ? "2時間で 上昇"
      : forecast.direction === "down"
        ? "2時間で 下落"
        : "2時間は 横ばい";
  out.push(
    `<text x="856" y="440" font-family="${SANS}" font-size="31" font-weight="bold" fill="${palette.stroke}">${directionLine}</text>`,
    `<text x="856" y="482" font-family="${SANS}" font-size="17" fill="${DIM}">予測の成績（この端末の記録）</text>`,
  );
  if (score.scoredRecords >= MIN_SCORED_RECORDS && score.coveragePct != null) {
    out.push(
      `<text x="856" y="518" font-family="${SANS}" font-size="22" font-weight="bold" fill="${INK}">コーン収まり ${score.coveragePct}%</text>`,
    );
    out.push(
      score.dirTotal >= MIN_SCORED_RECORDS && score.dirPct != null
        ? `<text x="856" y="554" font-family="${SANS}" font-size="22" font-weight="bold" fill="${INK}">方向的中 ${score.dirPct}%（${score.dirTotal}件）</text>`
        : `<text x="856" y="554" font-family="${SANS}" font-size="22" font-weight="bold" fill="${INK}">方向的中は集計中</text>`,
    );
  } else {
    out.push(
      `<text x="856" y="518" font-family="${SANS}" font-size="22" font-weight="bold" fill="${INK}">集計中（判定 ${score.scoredRecords} 件）</text>`,
    );
  }
  out.push(
    `<text x="856" y="600" font-family="${SANS}" font-size="17" fill="${DIM}">当たるも外れるも、記録で正直に。</text>`,
    `<text x="36" y="640" font-family="${SANS}" font-size="17" fill="${DIM}">予測は模式（EMA+ATR）／ 実績で答え合わせ中</text>`,
    `</svg>`,
  );
  return out.join("");
}

async function imageDataUrl(src: string): Promise<string> {
  const res = await fetch(src);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("image read failed"));
    reader.readAsDataURL(blob);
  });
}

/** Render the card to a PNG and hand it to the OS share sheet,
 * falling back to a download where file sharing is unavailable. */
export async function createShareCardPng(
  input: ShareCardInput,
): Promise<"shared" | "downloaded"> {
  const dataUrl = await imageDataUrl(input.characterImageSrc);
  const svg = buildShareCardSvg(input, dataUrl);
  const svgUrl = URL.createObjectURL(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
  );
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("card render failed"));
      img.src = svgUrl;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = 1200 * scale;
    canvas.height = 675 * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.fillStyle = "#04070b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("png encode failed");
    const file = new File([blob], "suiba-forecast.png", {
      type: "image/png",
    });
    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files: File[] }) => Promise<void>;
    };
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      await nav.share({ files: [file] });
      return "shared";
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "suiba-forecast.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return "downloaded";
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}
