import { number as fmtNumber, percent as fmtPercent } from "../presentation.ts";

export const price = (v: number) => `${fmtNumber(v, 4)} USDC`;
export const signedPct = (ratio: number) =>
  `${ratio > 0 ? "+" : ""}${fmtPercent(ratio)}`;
