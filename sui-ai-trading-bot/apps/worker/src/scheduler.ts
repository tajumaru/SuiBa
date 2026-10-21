export const cadenceLimits = {
  candleMs: 300000,
  reflectionMs: 10000,
  recheckMs: 40000,
  maxReflectionMs: 60000,
  minimumSpacingMs: 30000,
};
export interface CadenceClock {
  wall(): number;
  mono(): number;
}
export const systemClock: CadenceClock = {
  wall: () => Date.now(),
  mono: () => performance.now(),
};
export interface CadenceInput {
  intervalMs: number;
  deepbook: boolean;
  latestClosedAt: number | null;
  healthy: boolean;
  blocked: boolean;
}
export interface CyclePlan {
  dueMono: number;
  at: number;
  delayMs: number;
  reason: "PERIODIC" | "BOUNDARY_RECHECK" | "SKIPPED_OVERDUE";
}
/** Monotonic fixed grid. UTC is used only to establish/reconfigure the phase.
 * One extra, bounded recheck per 5m boundary; no replay of missed slots. */
export class MarketCadence {
  private anchor: number | null = null;
  private interval = 0;
  private deepbook = false;
  private retriedBoundary: number | null = null;
  private priorDue: number | null = null;
  constructor(private clock: CadenceClock = systemClock) {}
  next(startedMono: number, input: CadenceInput): CyclePlan {
    const now = this.clock.mono(),
      wall = this.clock.wall(),
      period = Math.max(cadenceLimits.minimumSpacingMs, input.intervalMs);
    if (
      this.anchor === null ||
      period !== this.interval ||
      input.deepbook !== this.deepbook
    ) {
      const phase = input.deepbook ? cadenceLimits.reflectionMs : wall;
      const offset = (((phase - wall) % period) + period) % period;
      this.anchor = now + offset;
      this.interval = period;
      this.deepbook = input.deepbook;
      this.priorDue = null;
    }
    let due =
      this.anchor + (Math.floor((now - this.anchor) / period) + 1) * period;
    let reason: CyclePlan["reason"] =
      this.priorDue != null && now >= this.priorDue + period
        ? "SKIPPED_OVERDUE"
        : "PERIODIC";
    const boundary =
      Math.floor(wall / cadenceLimits.candleMs) * cadenceLimits.candleMs;
    // Never exempt freshness or error handling. Recheck only a healthy response
    // that is one bar behind within the existing 60s publication window.
    if (
      input.deepbook &&
      input.healthy &&
      !input.blocked &&
      input.latestClosedAt === boundary - cadenceLimits.candleMs &&
      wall >= boundary + cadenceLimits.reflectionMs &&
      wall < boundary + cadenceLimits.maxReflectionMs &&
      this.retriedBoundary !== boundary
    ) {
      const target = Math.max(
        startedMono + cadenceLimits.minimumSpacingMs,
        now + (boundary + cadenceLimits.recheckMs - wall),
      );
      if (
        target > now &&
        target < due &&
        wall + (target - now) < boundary + cadenceLimits.maxReflectionMs
      ) {
        due = target;
        reason = "BOUNDARY_RECHECK";
        this.retriedBoundary = boundary;
      }
    }
    due = Math.max(due, startedMono + cadenceLimits.minimumSpacingMs);
    this.priorDue = due;
    return {
      dueMono: due,
      at: wall + (due - now),
      delayMs: Math.max(0, due - now),
      reason,
    };
  }
}
/** Single awaited cycle. Long cycles skip elapsed slots instead of accumulating work. */
export class MarketScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopped = false;
  private busy = false;
  private cadence: MarketCadence;
  constructor(
    private tick: () => Promise<void>,
    private input: () => CadenceInput,
    private planned: (plan: CyclePlan | null) => void,
    private failed: (error: unknown) => void,
    private clock: CadenceClock = systemClock,
  ) {
    this.cadence = new MarketCadence(clock);
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.timer = setTimeout(() => void this.run(), 0);
    this.timer.unref?.();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.planned(null);
  }
  private async run() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    const began = this.clock.mono();
    try {
      // Publish the provisional next slot so a stalled in-flight cycle is diagnosable.
      this.planned(
        this.cadence.next(began, { ...this.input(), healthy: false }),
      );
      await this.tick();
      if (!this.stopped) {
        const plan = this.cadence.next(began, this.input());
        this.planned(plan);
        this.timer = setTimeout(() => void this.run(), plan.delayMs);
        this.timer.unref?.();
      }
    } catch (error) {
      this.stopped = true;
      this.failed(error);
    } finally {
      this.busy = false;
    }
  }
}
