import type { BrowserSessions } from "./browser-session.ts";
import type { DeploymentGate } from "./deployment-safety.ts";
import type { PaperCheckSession } from "./paper-check-session.ts";
import type { BotDatabase } from "../../../packages/database/src/index.ts";
import type { BotEngine } from "./engine.ts";
import type { ReadOnlySuiClient } from "../../../packages/sui-client/src/index.ts";
import type { ValidationRecorder } from "./validation.ts";
import type { DashboardService } from "./dashboard-feed.ts";
import type { ChartHistoryClient } from "./chart-history-client.ts";
import type { MarketScheduler } from "./scheduler.ts";
import type { ChainSampler } from "./chainInfo.ts";
import type { BtcSampler } from "./btcInfo.ts";
import type { LongTermSampler } from "./longTerm.ts";
import type { BookImbalanceSampler } from "./bookInfo.ts";
import type { resolveSuiGrpcEndpoints } from "./suiEndpoints.ts";
import type { TradingPair } from "../../../packages/shared/src/index.ts";
import type { DisplaySamplers } from "./display-samplers.ts";
import { PredecessorReset } from "./predecessor-reset.ts";
import { apiAccess } from "../../../packages/shared/src/api.ts";

export interface WorkerContextInit {
  browserSessions: BrowserSessions;
  deploymentGate: DeploymentGate;
  paperCheck: PaperCheckSession;
  selectionDb: BotDatabase;
  rootDatabasePath: string;
  bootId: string;
  marketMode: string;
  reconstruction: string;
  validationEnabled: boolean;
  suiGrpcEndpoints: ReturnType<typeof resolveSuiGrpcEndpoints>;
  pair: TradingPair;
  db: BotDatabase;
  samplers: DisplaySamplers;
}

/**
 * The worker's shared context, extracted from the boot script:
 * the immutable boot configuration (gates, sessions, env-derived
 * modes, the display samplers) plus the live runtime state the
 * request handler and the factories pass around. The state
 * fields are reassigned as a unit by a pair switch, exactly as
 * the boot script's module-level lets were; the engine-shaped
 * fields are assigned during boot, before the server listens.
 */
export class WorkerContext {
  predecessorReset: PredecessorReset;
  readonly resetPairs = new Set<TradingPair>();
  readonly browserSessions: BrowserSessions;
  readonly deploymentGate: DeploymentGate;
  readonly paperCheck: PaperCheckSession;
  readonly selectionDb: BotDatabase;
  readonly rootDatabasePath: string;
  readonly bootId: string;
  readonly marketMode: string;
  readonly reconstruction: string;
  readonly validationEnabled: boolean;
  readonly suiGrpcEndpoints: ReturnType<typeof resolveSuiGrpcEndpoints>;
  readonly pairPath: (value: TradingPair) => string;
  readonly chainSampler: ChainSampler;
  readonly btcSampler: BtcSampler;
  readonly longTermSampler: LongTermSampler;
  readonly bookSamplers: Record<TradingPair, BookImbalanceSampler>;
  readonly chainTimer: ReturnType<typeof setInterval>;
  pair: TradingPair;
  db: BotDatabase;
  engine!: BotEngine;
  sui!: ReadOnlySuiClient;
  validation: ValidationRecorder | undefined;
  dashboard!: DashboardService;
  chartHistory!: ChartHistoryClient;
  scheduler!: MarketScheduler;
  stopping = false;
  switching = false;
  backtestBusy = false;
  activeTick: Promise<void> | undefined = undefined;
  inFlightRequests = 0;
  lastExportAt = 0;
  constructor(init: WorkerContextInit) {
    this.browserSessions = init.browserSessions;
    this.deploymentGate = init.deploymentGate;
    this.paperCheck = init.paperCheck;
    this.selectionDb = init.selectionDb;
    this.rootDatabasePath = init.rootDatabasePath;
    this.bootId = init.bootId;
    this.marketMode = init.marketMode;
    this.reconstruction = init.reconstruction;
    this.validationEnabled = init.validationEnabled;
    this.suiGrpcEndpoints = init.suiGrpcEndpoints;
    this.pairPath = (value: TradingPair) =>
      value === "SUI_USDC"
        ? init.rootDatabasePath
        : init.rootDatabasePath + ".WAL_USDC.sqlite";
    this.chainSampler = init.samplers.chainSampler;
    this.btcSampler = init.samplers.btcSampler;
    this.longTermSampler = init.samplers.longTermSampler;
    this.bookSamplers = init.samplers.bookSamplers;
    this.chainTimer = init.samplers.chainTimer;
    this.pair = init.pair;
    this.db = init.db;
    this.predecessorReset = new PredecessorReset(
      this.db,
      apiAccess,
      this.bootId,
      this.pair,
    );
    this.resetPairs.add(this.pair);
    this.validation = undefined;
  }
}
