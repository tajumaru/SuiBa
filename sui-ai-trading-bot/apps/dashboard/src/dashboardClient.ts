import type { BotEngine } from "../../worker/src/engine.ts";
import type { DashboardService } from "../../worker/src/dashboard-feed.ts";
import type { Candle, Timeframe } from "../../../packages/shared/src/index.ts";
import {
  browserDigest,
  canonicalFrame,
} from "../../../packages/shared/src/dashboard-wire.ts";
import type { SettingsApi } from "./settingsPresets.ts";
type State = ReturnType<BotEngine["snapshot"]>;
type Summary = ReturnType<DashboardService["summary"]>;
export class DashboardClient {
  private legacy = false;
  private issued = 0;
  private applied = 0;
  private state: State | null = null;
  private versions = new Map<number, string>();
  private recordsVersion: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  async poll(
    api: SettingsApi,
    timeframe: Timeframe | null,
    records: boolean,
    onSummary: (state: State) => void,
  ) {
    const request = ++this.issued;
    let reply: Summary | undefined;
    if (!this.legacy) {
      try {
        const raw = (await api("dashboard/summary")) as Summary;
        if (
          raw.schema === 1 &&
          raw.summary?.runtime &&
          raw.frames &&
          raw.recordsVersion
        )
          reply = raw;
        else if (raw.schema != null)
          throw Error("UNSUPPORTED_DASHBOARD_SCHEMA");
        else this.legacy = true;
      } catch (e) {
        if (e instanceof Error && ["HTTP_404", "NOT_FOUND"].includes(e.message))
          this.legacy = true;
        else throw e;
      }
    }
    if (this.legacy) {
      const state = (await api("state")) as State;
      if (request < this.applied && this.state)
        return { state: this.state, channelError: null };
      this.applied = request;
      this.state = state;
      onSummary(state);
      return { state, channelError: null };
    }
    if (request < this.applied && this.state)
      return { state: this.state, channelError: null };
    this.applied = request;
    const s = reply!;
    this.state = {
      ...s.summary,
      candles: this.state?.candles ?? [],
      candlesByTimeframe: this.state?.candlesByTimeframe ?? {
        300: [],
        900: [],
        3600: [],
      },
      trades: this.state?.trades ?? [],
      orders: this.state?.orders ?? [],
      riskEvents: this.state?.riskEvents ?? [],
    };
    onSummary(this.state);
    // Status requests never wait behind chart/history transfers.
    const job = this.tail
      .catch(() => {})
      .then(() => this.channels(api, timeframe, records, s));
    this.tail = job.catch(() => {});
    return job;
  }
  private async channels(
    api: SettingsApi,
    timeframe: Timeframe | null,
    records: boolean,
    s: Summary,
  ) {
    let channelError: string | null = null;
    try {
      if (
        timeframe != null &&
        this.versions.get(timeframe) !== s.frames[timeframe]
      ) {
        let base = this.versions.get(timeframe) ?? null;
        let response = (await api(
          `dashboard/candles?timeframe=${timeframe}${base ? `&version=${base}` : ""}`,
        )) as ReturnType<DashboardService["candles"]>;
        if (!response.reset && response.baseVersion !== base) {
          response = (await api(
            `dashboard/candles?timeframe=${timeframe}`,
          )) as typeof response;
          if (!response.reset) throw Error("DASHBOARD_DELTA_MISSING");
          base = null;
        }
        if (
          response.schema !== 1 ||
          response.timeframe !== timeframe ||
          !Array.isArray(response.upserts) ||
          !Array.isArray(response.removed)
        )
          throw Error("DASHBOARD_DELTA_INVALID");
        const merged = new Map<number, Candle>(
          (response.reset ? [] : this.state!.candlesByTimeframe[timeframe]).map(
            (c) => [c.timestamp, c],
          ),
        );
        for (const t of response.removed) merged.delete(t);
        for (const c of response.upserts) {
          if (c.timeframe !== timeframe) throw Error("DASHBOARD_DELTA_INVALID");
          merged.set(c.timestamp, c);
        }
        const candles = [...merged.values()].sort(
          (a, b) => a.timestamp - b.timestamp,
        );
        if (
          candles.length > 1000 ||
          (await browserDigest(canonicalFrame(candles))) !== response.version
        ) {
          this.versions.delete(timeframe);
          throw Error("DASHBOARD_DELTA_CHECKSUM");
        }
        this.state = {
          ...this.state!,
          candlesByTimeframe: {
            ...this.state!.candlesByTimeframe,
            [timeframe]: candles,
          },
          ...(timeframe === 300 ? { candles } : {}),
        };
        this.versions.set(timeframe, response.version);
      }
      if (records && this.recordsVersion !== s.recordsVersion) {
        const r = (await api("dashboard/records")) as ReturnType<
          DashboardService["records"]
        >;
        if (
          r.schema !== 1 ||
          (await browserDigest(JSON.stringify(r.records))) !== r.version
        )
          throw Error("DASHBOARD_RECORDS_CHECKSUM");
        this.state = { ...this.state!, ...r.records };
        this.recordsVersion = r.version;
      }
    } catch {
      channelError =
        "チャート・履歴の更新に失敗しました。表示済みのデータは古い可能性があります。次回更新で再取得します。";
    }
    return { state: this.state!, channelError };
  }
}
