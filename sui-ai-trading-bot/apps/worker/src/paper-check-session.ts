/** Opt-in VPS test lease. No database, network, Worker startup or reset path. */
export class PaperCheckSession {
  readonly enabled: boolean;
  private deadline: number | null = null;
  private wallDeadline: number | null = null;
  private last: number;
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
  }
  expired() {
    const now = this.clock();
    if (now < this.last || !Number.isFinite(now)) this.closed = true;
    this.last = now;
    if (
      this.deadline !== null &&
      (now >= this.deadline || this.wall() >= this.wallDeadline!)
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
  arm(pair: string) {
    if (
      !this.enabled ||
      !this.pairAllowed(pair) ||
      this.deadline !== null ||
      this.expired()
    )
      throw Error("PAPER_CHECK_ARM_REJECTED");
    this.deadline = this.clock() + 30 * 60 * 1000;
    this.wallDeadline = this.wall() + 30 * 60 * 1000;
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
