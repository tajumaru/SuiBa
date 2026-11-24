#!/usr/bin/env python3
"""Fetch SUI_USDC 5m candles from the DeepBook indexer, paging backwards.
Range: 2026-04-24T00:00Z (warmup + May-1 pre-window) to now.
Rows: [ts_ms, open, high, low, close, volume]. Saves candles.json."""
import json, sys, time, urllib.request

BASE = "https://deepbook-indexer.mainnet.mystenlabs.com/ohclv/SUI_USDC"
STEP = 300_000  # 5m in ms
START_MS = 1776988800000  # 2026-04-24T00:00:00Z

def fetch(start_ms, end_ms):
    url = f"{BASE}?interval=5m&start_time={start_ms}&end_time={end_ms}&limit=1000"
    req = urllib.request.Request(url, headers={"User-Agent": "unlock-study/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read().decode())
    return data["candles"] if isinstance(data, dict) else data

def main():
    now_ms = int(time.time() * 1000)
    end = (now_ms // STEP) * STEP  # align to candle boundary
    seen = {}
    cursor_end = end
    pages = 0
    while cursor_end > START_MS:
        start = max(START_MS, cursor_end - 1000 * STEP)
        try:
            rows = fetch(start, cursor_end)
        except Exception as e:
            print(f"fetch failed at {start}-{cursor_end}: {e}", file=sys.stderr)
            break
        pages += 1
        if not rows:
            print(f"empty page at {start}-{cursor_end}; stopping", file=sys.stderr)
            break
        for row in rows:
            seen[int(row[0])] = row
        oldest = min(int(r[0]) for r in rows)
        print(f"page {pages}: {len(rows)} rows, oldest={oldest}", file=sys.stderr)
        if oldest >= cursor_end:
            break
        cursor_end = oldest  # page backwards; dedupe by ts handles overlap
        time.sleep(0.2)
    candles = [seen[ts] for ts in sorted(seen)]
    out = {
        "pair": "SUI_USDC",
        "interval": "5m",
        "fetched_at_ms": now_ms,
        "count": len(candles),
        "candles": candles,
    }
    with open("candles.json", "w") as f:
        json.dump(out, f)
    print(f"saved {len(candles)} candles")

if __name__ == "__main__":
    main()
