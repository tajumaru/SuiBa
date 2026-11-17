import type { BotDatabase } from "../../../packages/database/src/index.ts";

export const LIQUIDATION_STREAM =
  "wss://fstream.binance.com/ws/suiusdt@forceOrder";
export const LIQUIDATION_COVERAGE_WINDOW_MS = 24 * 3600_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export interface LiquidationStatus {
  source: "Binance USD-M Futures (external reference)";
  connected: boolean;
  coveragePct: number;
  coveredMs: number;
  gapMs: number;
  gaps: number;
  lastConnectedAt: number | null;
  lastEventAt: number | null;
}

type Socket = {
  addEventListener(
    name: string,
    listener: (event: { data?: unknown }) => void,
  ): void;
  close(): void;
};
type SocketFactory = (url: string) => Socket;
type Timer = ReturnType<typeof setTimeout>;

export function parseForceOrder(data: unknown): {
  timestamp: number;
  side: "long" | "short";
  notionalUsd: number;
} | null {
  try {
    const value = JSON.parse(typeof data === "string" ? data : String(data));
    const order = value?.o;
    const timestamp = Number(order?.T ?? value?.E);
    const price = Number(order?.ap || order?.p);
    const quantity = Number(order?.z || order?.q);
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(price) ||
      !Number.isFinite(quantity) ||
      timestamp <= 0 ||
      price <= 0 ||
      quantity <= 0 ||
      !["BUY", "SELL"].includes(order?.S)
    )
      return null;
    return {
      timestamp,
      // A forced sell closes a long; a forced buy closes a short.
      side: order.S === "SELL" ? "long" : "short",
      notionalUsd: price * quantity,
    };
  } catch {
    return null;
  }
}

export class LiquidationCollector {
  private socket: Socket | null = null;
  private reconnectTimer: Timer | null = null;
  private stopped = false;
  private connected = false;
  private segmentStartedAt: number;
  private retryMs = RECONNECT_MIN_MS;
  private lastConnectedAt: number | null = null;
  private lastEventAt: number | null = null;

  constructor(
    private db: Pick<
      BotDatabase,
      | "addLiquidation"
      | "recordLiquidationCoverage"
      | "liquidationCoverage"
      | "pruneLiquidations"
    >,
    private socketFactory: SocketFactory = (url) => new WebSocket(url),
    private now: () => number = Date.now,
    private schedule: (fn: () => void, ms: number) => Timer = setTimeout,
  ) {
    const startedAt = now();
    try {
      this.segmentStartedAt = db.liquidationCoverage(0).at(-1)?.endedAt ?? startedAt;
    } catch {
      this.segmentStartedAt = startedAt;
    }
  }

  start() {
    this.connect();
    return this;
  }

  private connect() {
    if (this.stopped) return;
    try {
      const socket = this.socketFactory(LIQUIDATION_STREAM);
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.stopped || socket !== this.socket) return;
        const at = this.now();
        this.finishSegment("gap", at);
        this.connected = true;
        this.segmentStartedAt = at;
        this.lastConnectedAt = at;
        this.retryMs = RECONNECT_MIN_MS;
        try {
          this.db.pruneLiquidations(at);
        } catch {}
      });
      socket.addEventListener("message", (event) => {
        if (!this.connected || socket !== this.socket) return;
        const parsed = parseForceOrder(event.data);
        if (!parsed) return;
        try {
          this.db.addLiquidation(parsed);
          this.lastEventAt = parsed.timestamp;
        } catch {}
      });
      const disconnected = () => this.disconnect(socket);
      socket.addEventListener("close", disconnected);
      socket.addEventListener("error", disconnected);
    } catch {
      this.queueReconnect();
    }
  }

  private disconnect(socket: Socket) {
    if (this.stopped || socket !== this.socket) return;
    const at = this.now();
    if (this.connected) this.finishSegment("connected", at);
    this.connected = false;
    this.segmentStartedAt = at;
    this.socket = null;
    try {
      socket.close();
    } catch {}
    this.queueReconnect();
  }

  private queueReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(RECONNECT_MAX_MS, this.retryMs * 2);
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
    this.reconnectTimer.unref?.();
  }

  private finishSegment(kind: "connected" | "gap", endedAt: number) {
    try {
      this.db.recordLiquidationCoverage(kind, this.segmentStartedAt, endedAt);
    } catch {}
  }

  status(now = this.now()): LiquidationStatus {
    const since = now - LIQUIDATION_COVERAGE_WINDOW_MS;
    let rows: ReturnType<BotDatabase["liquidationCoverage"]> = [];
    try {
      rows = this.db.liquidationCoverage(since);
    } catch {}
    rows.push({
      kind: this.connected ? "connected" : "gap",
      startedAt: this.segmentStartedAt,
      endedAt: now,
    });
    let coveredMs = 0;
    let gapMs = 0;
    let gaps = 0;
    for (const row of rows) {
      const duration = Math.max(
        0,
        Math.min(now, row.endedAt) - Math.max(since, row.startedAt),
      );
      if (row.kind === "connected") coveredMs += duration;
      else {
        gapMs += duration;
        if (duration > 0) gaps++;
      }
    }
    const observed = coveredMs + gapMs;
    return {
      source: "Binance USD-M Futures (external reference)",
      connected: this.connected,
      coveragePct: observed ? (coveredMs / observed) * 100 : 0,
      coveredMs,
      gapMs,
      gaps,
      lastConnectedAt: this.lastConnectedAt,
      lastEventAt: this.lastEventAt,
    };
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const at = this.now();
    this.finishSegment(this.connected ? "connected" : "gap", at);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.socket?.close();
    } catch {}
    this.socket = null;
    this.connected = false;
  }
}

export function startLiquidationCollector(db: BotDatabase) {
  return new LiquidationCollector(db).start();
}
