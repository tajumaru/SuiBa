import { z } from "zod";
import type { RealTradeCapConfig } from "../../../../packages/shared/src/index.ts";

const poolsSchema = z.array(z.looseObject({ pool_name: z.string() }));
const bookParamsSchema = z.object({
  min_size: z.number().int().positive(),
  lot_size: z.number().int().positive(),
  tick_size: z.number().int().positive(),
});

type BookParams = {
  minSize: number;
  lotSize: number;
  tickSize: number;
};

/** Like the fee cache, reuse a successful read within a known chain epoch.
 * Keep the last successful book parameters available after a failed refresh. */
export class RealBookParamsCache {
  private lastSuccessful: { epoch: number | null; params: BookParams } | null =
    null;

  constructor(
    private readonly config: Pick<RealTradeCapConfig, "indexerUrl" | "poolKey">,
    private readonly fetchPools: typeof fetch = fetch,
  ) {}

  async get(currentEpoch: number | null): Promise<BookParams | null> {
    if (currentEpoch !== null && this.lastSuccessful?.epoch === currentEpoch)
      return this.lastSuccessful.params;

    try {
      const response = await this.fetchPools(
        new URL("/get_pools", this.config.indexerUrl),
      );
      if (!response.ok) throw Error(`REAL_BOOK_PARAMS_HTTP_${response.status}`);
      const pools = poolsSchema.parse(await response.json());
      const pool = bookParamsSchema.parse(
        pools.find((pool) => pool.pool_name === this.config.poolKey),
      );
      const params = {
        minSize: pool.min_size,
        lotSize: pool.lot_size,
        tickSize: pool.tick_size,
      };
      this.lastSuccessful = { epoch: currentEpoch, params };
      return params;
    } catch {
      return this.lastSuccessful?.params ?? null;
    }
  }
}
