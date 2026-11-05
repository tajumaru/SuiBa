import { ChainSampler, createChainInfoFetcher } from "./chainInfo.ts";
import { BtcSampler, createBtcPriceFetcher } from "./btcInfo.ts";
import { LongTermSampler, createDailyCandleFetcher } from "./longTerm.ts";
import {
  BookImbalanceSampler,
  createBookSampleFetcher,
  type BookSample,
} from "./bookInfo.ts";
import type { TradingPair } from "../../../packages/shared/src/index.ts";
import type { resolveSuiGrpcEndpoints } from "./suiEndpoints.ts";

export interface DisplaySamplers {
  chainSampler: ChainSampler;
  btcSampler: BtcSampler;
  longTermSampler: LongTermSampler;
  bookSamplers: Record<TradingPair, BookImbalanceSampler>;
  chainTimer: ReturnType<typeof setInterval>;
}

/**
 * The display-only samplers, extracted from the worker boot:
 * Sui chain info, BTC/USD, long-term daily candles and the
 * order-book imbalance. Each runs on its own fetch path and
 * unref'd timer, fully beside the trading paths — a failure
 * only stales the displayed numbers. Construction starts the
 * first poll of each sampler immediately, in the same order
 * the boot sequence always has.
 */
export function startDisplaySamplers(
  suiGrpcEndpoints: ReturnType<typeof resolveSuiGrpcEndpoints>,
): DisplaySamplers {
  // Display-only Sui chain sampling (epoch / checkpoint / TPS for
  // the dashboard's chain strip). A dedicated raw fetcher and
  // timer, fully beside the trading paths: its failure only
  // freezes the displayed numbers (see chainInfo.ts for why it
  // must not share the trading client's transport plumbing).
  const chainSampler = new ChainSampler();
  const fetchChainInfo = createChainInfoFetcher(
    suiGrpcEndpoints.primary,
    suiGrpcEndpoints.fallbacks,
  );
  const pollChain = async () => {
    const raw = await fetchChainInfo();
    if (raw) chainSampler.observe(raw);
  };
  void pollChain();
  const chainTimer = setInterval(() => void pollChain(), 15000);
  chainTimer.unref();
  // Display-only BTC/USD sampling for the narration's market
  // weather (see btcInfo.ts). Its own plain fetch and timer,
  // beside the trading paths; a failure only stales the sample
  // and the mutters stop until it recovers.
  const btcSampler = new BtcSampler();
  const fetchBtcPrice = createBtcPriceFetcher();
  const pollBtc = async () => {
    const price = await fetchBtcPrice();
    if (price != null) btcSampler.observe(price);
  };
  void pollBtc();
  const btcTimer = setInterval(() => void pollBtc(), 60000);
  btcTimer.unref();
  // Display-only long-term daily candles for the dashboard's
  // level map (see longTerm.ts). Six hours is plenty for a
  // series that changes once a day; a failure keeps the last
  // good series. SUI only — WAL has no equivalent listing.
  const longTermSampler = new LongTermSampler();
  const fetchDailyCandles = createDailyCandleFetcher();
  const pollLongTerm = async () => {
    longTermSampler.observe(await fetchDailyCandles());
  };
  void pollLongTerm();
  const longTermTimer = setInterval(() => void pollLongTerm(), 6 * 3600 * 1000);
  longTermTimer.unref();
  // Display-only book imbalance, sampled on its own fetch path
  // for the dashboard's model outlook (see bookInfo.ts). The
  // DeepBook routes already hold a validated book; this sampler
  // covers the GeckoTerminal route, which never fetches one.
  const bookSamplers: Record<TradingPair, BookImbalanceSampler> = {
    SUI_USDC: new BookImbalanceSampler(),
    WAL_USDC: new BookImbalanceSampler(),
  };
  const bookFetchers: Record<TradingPair, () => Promise<BookSample | null>> = {
    SUI_USDC: createBookSampleFetcher("SUI_USDC"),
    WAL_USDC: createBookSampleFetcher("WAL_USDC"),
  };
  const pollBooks = async () => {
    for (const p of ["SUI_USDC", "WAL_USDC"] as const)
      bookSamplers[p].observeSample(await bookFetchers[p]());
  };
  void pollBooks();
  const bookTimer = setInterval(() => void pollBooks(), 45000);
  bookTimer.unref();
  return { chainSampler, btcSampler, longTermSampler, bookSamplers, chainTimer };
}
