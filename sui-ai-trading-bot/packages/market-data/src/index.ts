import { validateCandles } from "./validation.ts";
import { z } from "zod";
import {
  coin,
  SUI,
  USDC,
  jsonFetch,
  type Candle,
  type Timeframe,
} from "../../shared/src/index.ts";
const base = "https://api.geckoterminal.com/api/v2";
const tokenSchema = z.object({
  id: z.string(),
  attributes: z.object({ address: z.string() }),
});
const poolSchema = z.object({
  id: z.string(),
  attributes: z.object({
    address: z.string(),
    reserve_in_usd: z.string().optional(),
    volume_usd: z.object({ h24: z.string() }).optional(),
  }),
  relationships: z.object({
    base_token: z.object({ data: z.object({ id: z.string() }) }),
    quote_token: z.object({ data: z.object({ id: z.string() }) }),
  }),
});
type Pool = z.infer<typeof poolSchema>;
export { validateCandles } from "./validation.ts";
export class GeckoMarketData {
  private pool: Pool | null = null;
  private suiSide: "base" | "quote" = "base";
  constructor(private poolAddress?: string) {}
  async discover() {
    const endpoint = this.poolAddress
      ? `/networks/sui-network/pools/${encodeURIComponent(this.poolAddress)}?include=base_token,quote_token`
      : `/networks/sui-network/tokens/${encodeURIComponent(SUI)}/pools?include=base_token,quote_token`;
    const raw = await jsonFetch(base + endpoint);
    const result = z
      .object({
        data: z.union([poolSchema, z.array(poolSchema)]),
        included: z.array(tokenSchema),
      })
      .parse(raw);
    const tokens = new Map(
      result.included.map((t) => [t.id, t.attributes.address]),
    );
    const pools = Array.isArray(result.data) ? result.data : [result.data];
    const candidates = pools
      .filter((p) => {
        try {
          const a = coin(tokens.get(p.relationships.base_token.data.id)!),
            b = coin(tokens.get(p.relationships.quote_token.data.id)!);
          return a !== b;
        } catch {
          return false;
        }
      })
      .sort(
        (a, b) =>
          Number(b.attributes.volume_usd?.h24 ?? 0) -
          Number(a.attributes.volume_usd?.h24 ?? 0),
      );
    const selected = candidates[0];
    if (!selected) throw new Error("NATIVE_USDC_POOL_NOT_FOUND");
    this.pool = selected;
    this.suiSide =
      coin(tokens.get(selected.relationships.base_token.data.id)!) === SUI
        ? "base"
        : "quote";
    return selected.attributes.address;
  }
  async candles(timeframe: Timeframe, now = Date.now()): Promise<Candle[]> {
    if (!this.pool) await this.discover();
    const frame = timeframe === 3600 ? "hour" : "minute",
      aggregate = timeframe === 3600 ? 1 : timeframe / 60;
    // Request SUI directly so OHLCV uses the other pool token (Native USDC) as currency.
    const url = `${base}/networks/sui-network/pools/${encodeURIComponent(this.pool!.attributes.address)}/ohlcv/${frame}?aggregate=${aggregate}&limit=1000&currency=token&token=${this.suiSide}&include_empty_intervals=false`;
    const r = z
      .object({
        data: z.object({
          attributes: z.object({
            ohlcv_list: z.array(
              z.tuple([
                z.number(),
                z.number(),
                z.number(),
                z.number(),
                z.number(),
                z.number(),
              ]),
            ),
          }),
        }),
      })
      .parse(await jsonFetch(url));
    const c = r.data.attributes.ohlcv_list
      .filter((row) => row[0] + timeframe <= now / 1000)
      .map(([timestamp, open, high, low, close, volume]) => ({
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        timeframe,
        source: `GeckoTerminal:${this.pool!.attributes.address}:USDC`,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
    return validateCandles(c, timeframe, now);
  }
}
