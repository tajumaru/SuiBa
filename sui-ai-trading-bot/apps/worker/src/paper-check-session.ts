/** Opt-in VPS session. No database, network, Worker startup or reset path.
 * sui-30m keeps its bounded test lease (up to the longest validation
 * run, 24h); sui-prod requires one explicit, unbounded arm. Neither
 * mode persists authorization across Worker boots.
 */

/** Longest validation run the controller can request. The arm lease
 * must cover the whole run: the controller enforces the exact
 * per-run cutoff with its own timers and monitoring, while this cap
 * only keeps the lease finite. It was 30 minutes from the era when
 * every validation run lasted 30 minutes; the first 6h run on
 * 2026-11-07 was rejected at arm (HTTP 409) because its cutoff
 * exceeded the cap. */
const MAX_VALIDATION_LEASE_MS = 24 * 60 * 60 * 1000;
export class PaperCheckSession {
  readonly enabled: boolean;
  private readonly production: boolean;
  private armed = false;
  private deadline: number | null = null;
  private wallDeadline: number | null = null;
  private last: number;
  private lastWall: number;
  private closed = false;
  constructor(
    mode?: string,
    private clock = () => performance.now(),
    private wall = () => Date.now(),
  ) {
    if (mode !== undefined && mode !== "sui-30m" && mode !== "sui-prod")
      throw Error("INVALID_PAPER_CHECK_MODE");
    this.enabled = mode !== undefined;
    this.production = mode === "sui-prod";
    this.last = clock();
    this.lastWall = wall();
    if (
      this.production &&
      (!Number.isFinite(this.last) || !Number.isFinite(this.lastWall))
    )
      this.closed = true;
  }
  expired() {
    const now = this.clock();
    const wall = this.wall();
    if (
      now < this.last ||
      wall < this.lastWall ||
      !Number.isFinite(now) ||
      !Number.isFinite(wall)
    )
      this.closed = true;
    this.last = now;
    this.lastWall = wall;
    if (
      this.deadline !== null &&
      (now >= this.deadline || wall >= this.wallDeadline!)
    )
      this.closed = true;
    return this.enabled && this.closed;
  }
  pairAllowed(pair: string) {
    return !this.enabled || pair === "SUI_USDC";
  }
  ordersAllowed(pair: string) {
    return (
      !this.enabled || (this.pairAllowed(pair) && this.armed && !this.expired())
    );
  }
  arm(pair: string, expiresAt: number | undefined, issuedAt: number) {
    const wall = this.wall();
    if (
      !this.enabled ||
      !this.pairAllowed(pair) ||
      this.armed ||
      this.expired() ||
      !Number.isSafeInteger(issuedAt) ||
      Math.abs(wall - issuedAt) > 2000 ||
      (this.production
        ? expiresAt !== undefined
        : !Number.isSafeInteger(expiresAt) ||
          expiresAt! <= wall ||
          expiresAt! > issuedAt + MAX_VALIDATION_LEASE_MS)
    )
      throw Error("PAPER_CHECK_ARM_REJECTED");
    if (!this.production) {
      this.deadline =
        this.clock() + Math.min(expiresAt! - wall, MAX_VALIDATION_LEASE_MS);
      this.wallDeadline = expiresAt!;
    }
    this.armed = true;
  }
  status() {
    return {
      enabled: this.enabled,
      armed: this.armed,
      expired: this.expired(),
      expires: this.wallDeadline,
    };
  }
}
