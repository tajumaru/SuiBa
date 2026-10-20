import { BotDatabase } from "./index.ts";
import type {
  LiveState,
  LiveStore,
  PreviewResult,
} from "../../live-trading/src/types.ts";
import { LiveError, address } from "../../live-trading/src/policy.ts";
/** Separate live keys: never modify PAPER portfolio, orders, settings, or runtime. */
export class SqliteLiveStore implements LiveStore {
  constructor(private db: BotDatabase) {
    if (!db.get("live:state"))
      db.set("live:state", {
        running: false,
        emergency: false,
        reason: "RESTART_STOP",
        walletAddress: null,
        activeOrder: null,
      } satisfies LiveState);
  }
  state() {
    return this.db.get<LiveState>("live:state")!;
  }
  stop(reason: string) {
    this.db.set("live:state", { ...this.state(), running: false, reason });
  }
  emergencyStop() {
    this.db.set("live:state", {
      ...this.state(),
      emergency: true,
      running: false,
      reason: "EMERGENCY_STOP",
    });
  }
  startPreview(wallet: string) {
    const changed = this.db.transaction(() => {
      const state = this.state();
      if (state.emergency || state.activeOrder)
        throw new LiveError("LIVE_BLOCKED");
      if (state.walletAddress && state.walletAddress !== address(wallet)) {
        this.stop("WALLET_CHANGED");
        return true;
      }
      this.db.set("live:state", {
        ...state,
        running: false,
        reason: null,
        walletAddress: address(wallet),
      });
      return false;
    });
    if (changed) throw new LiveError("WALLET_CHANGED");
  }
  reserve(orderId: string) {
    this.db.transaction(() => {
      const state = this.state();
      if (state.reason || state.emergency || state.activeOrder)
        throw new LiveError("LIVE_BLOCKED");
      if (this.db.get("live:order:" + orderId))
        throw new LiveError("DUPLICATE_ORDER");
      this.db.set("live:order:" + orderId, { status: "PREVIEWING" });
      this.db.set("live:state", { ...state, activeOrder: orderId });
    });
  }
  complete(orderId: string, result: PreviewResult) {
    this.db.transaction(() => {
      const state = this.state();
      if (state.emergency || state.reason || state.activeOrder !== orderId)
        throw new LiveError("LIVE_BLOCKED");
      this.db.set("live:order:" + orderId, result);
      this.db.set("live:state", { ...state, activeOrder: null });
    });
  }
  fail(orderId: string, reason: string) {
    this.db.transaction(() => {
      this.db.set("live:order:" + orderId, {
        status: "PREVIEW_FAILED",
        reason,
      });
      this.db.set("live:state", {
        ...this.state(),
        activeOrder: null,
        running: false,
        reason,
      });
    });
  }
}
