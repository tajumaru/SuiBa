/** Browser → worker reachability, independent of the Bot's market/safety state. */
export class ConnectionRecovery {
  offline = false;
  private failures = 0;
  private retryAt = 0;
  private auxiliaryAt = 0;

  constructor(
    private readonly changed: (offline: boolean) => void,
    private readonly clock = Date.now,
    private readonly random = Math.random,
  ) {}

  fail() {
    const now = this.clock();
    // Concurrent failures from the same outage must not multiply the backoff.
    if (this.offline && now < this.retryAt) return;
    this.failures++;
    this.retryAt =
      now +
      Math.min(30000, 5000 * 2 ** Math.min(this.failures - 1, 3)) +
      Math.floor(this.random() * 1000);
    this.offline = true;
    this.changed(true);
  }

  recovered() {
    if (!this.offline) return;
    this.offline = false;
    this.failures = 0;
    this.retryAt = 0;
    // Let the summary/channels finish before the operations feed resumes.
    this.auxiliaryAt = this.clock() + 2000 + Math.floor(this.random() * 1000);
    this.changed(false);
  }

  get pollDelay() {
    return this.offline ? Math.max(0, this.retryAt - this.clock()) : 10000;
  }

  get canPoll() {
    return !this.offline || this.clock() >= this.retryAt;
  }

  get canReadAuxiliary() {
    return !this.offline && this.clock() >= this.auxiliaryAt;
  }
}

export class ConnectionUnavailable extends Error {
  constructor() {
    super("BOT_RECONNECTING");
  }
}

export function isConnectionFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      ["TimeoutError", "AbortError"].includes(error.name))
  );
}
