/** Opt-in VPS test lease. No database, network, Worker startup or reset path. */
export class PaperCheckSession {
  readonly enabled: boolean;
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
    if (mode !== undefined && mode !== "sui-30m")
      throw Error("INVALID_PAPER_CHECK_MODE");
    this.enabled = mode === "sui-30m";
    this.last = clock();
    this.lastWall = wall();
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
      !this.enabled ||
      (this.pairAllowed(pair) && this.deadline !== null && !this.expired())
    );
  }
  arm(pair: string, expiresAt: number, issuedAt: number) {
    const wall = this.wall();
    if (
      !this.enabled ||
      !this.pairAllowed(pair) ||
      this.deadline !== null ||
      this.expired() ||
      !Number.isSafeInteger(expiresAt) ||
      !Number.isSafeInteger(issuedAt) ||
      Math.abs(wall - issuedAt) > 2000 ||
      expiresAt <= wall ||
      expiresAt > issuedAt + 30 * 60 * 1000
    )
      throw Error("PAPER_CHECK_ARM_REJECTED");
    this.deadline = this.clock() + Math.min(expiresAt - wall, 30 * 60 * 1000);
    this.wallDeadline = expiresAt;
  }
  status() {
    return {
      enabled: this.enabled,
      armed: this.deadline !== null,
      expired: this.expired(),
      expires: this.wallDeadline,
    };
  }
}
