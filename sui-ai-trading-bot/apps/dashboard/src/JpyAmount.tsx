import { formatJpy } from "./jpyDisplay.ts";

export function JpyAmount({
  usdc,
  usdJpy,
}: {
  usdc: number | null | undefined;
  usdJpy: number | null | undefined;
}) {
  const text = formatJpy(usdc, usdJpy);
  return text ? <small className="overview-sub"> {text}</small> : null;
}
