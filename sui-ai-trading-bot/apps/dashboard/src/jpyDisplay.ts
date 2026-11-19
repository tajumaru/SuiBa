const integer = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });

/** Formats a display-only USDC amount using the current USD/JPY rate. */
export function formatJpy(
  usdc: number | null | undefined,
  usdJpy: number | null | undefined,
): string | null {
  if (
    usdc == null ||
    usdJpy == null ||
    !Number.isFinite(usdc) ||
    !Number.isFinite(usdJpy) ||
    usdJpy <= 0
  )
    return null;
  const value = usdc * usdJpy;
  const roundedMagnitude = Math.round(Math.abs(value));
  const sign = value < 0 && roundedMagnitude > 0 ? "−" : "";
  return `≈ ${sign}¥${integer.format(roundedMagnitude)}`;
}
