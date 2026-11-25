export function parseBtcShadowSummary(text: string) {
  const header = /^\[btc-shadow-summary\]\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?=\s|$)/.exec(text);
  const at = header && Number.isFinite(Date.parse(header[1])) ? header[1] : null;
  const content = text.slice(at && header ? header[0].length : 0).trim();
  const marker = /(?:^|\s)動き:/.exec(content);
  const body = (marker ? content.slice(0, marker.index) : content).trim();
  const fields = marker && /^\s+price=(\d+) chg24=([+-]?\d+\.\d{2}) hi=(\d+) lo=(\d+) pts=(\d+(?:,\d+)+)$/.exec(
    content.slice(marker.index + marker[0].length),
  );
  if (!fields) return { at, body, move: null };

  const [price, chg24, hi, lo] = fields.slice(1, 5).map(Number);
  const pts = fields[5].split(",").map(Number);
  const move = [price, chg24, hi, lo, ...pts].every(Number.isFinite)
    ? { price, chg24, hi, lo, pts }
    : null;
  return { at, body, move };
}
