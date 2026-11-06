import type {
  MarketWeather,
  MarketWeatherKind,
} from "../../../packages/shared/src/index.ts";

/**
 * The market weather card on the Overview tab, under the
 * monthly report: the worker's mechanical five-grade read of
 * the pair's last 24 hours, with the three numbers it was
 * judged from. Not a forecast — the sky right now. Renders
 * nothing while the worker has too little data to judge.
 */
const WEATHER_LABEL: Record<MarketWeatherKind, { symbol: string; label: string }> = {
  clear: { symbol: "☀", label: "快晴" },
  sunny: { symbol: "⛅", label: "晴れ" },
  cloudy: { symbol: "☁", label: "曇り" },
  rain: { symbol: "☂", label: "雨" },
  storm: { symbol: "⚡", label: "嵐" },
};

const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

export function MarketWeatherCard({
  weather,
}: {
  weather: MarketWeather | null;
}) {
  if (!weather) return null;
  const w = WEATHER_LABEL[weather.kind];
  return (
    <section className="market-weather" aria-label="相場の天気">
      <div className="market-weather-head">
        <h3>相場の天気</h3>
        <span className="market-weather-now">
          <span className="market-weather-symbol" aria-hidden="true">
            {w.symbol}
          </span>
          {w.label}
        </span>
      </div>
      <dl className="market-weather-rows">
        <div>
          <dt>24時間</dt>
          <dd className={weather.change24hPct >= 0 ? "pos" : "neg"}>
            {signedPct(weather.change24hPct)}
          </dd>
        </div>
        <div>
          <dt>ボラ（ATR）</dt>
          <dd>{weather.atrPct.toFixed(2)}%</dd>
        </div>
        <div>
          <dt>RSI</dt>
          <dd>{Math.round(weather.rsi)}</dd>
        </div>
      </dl>
      <p className="market-weather-note">
        直近24時間の値動きからの機械判定
      </p>
    </section>
  );
}
