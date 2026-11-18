import { useEffect, useRef, useState } from "react";
import type { NarrationEntry, NarrationKind } from "./agentNarration.ts";
import type { SettingsApi } from "./settingsPresets.ts";

export const NARRATION_SHADOW_ENABLED_KEY =
  "suiba.narration.shadow-read.enabled";
const CURSOR_KEY = "suiba.narration.shadow-read.cursor.v1";
export const NARRATION_SHADOW_POLL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
const DEVICE_ONLY_KINDS = new Set<NarrationKind>([
  "sleepTalk",
  "chatUser",
  "chatReply",
  "chatPrompt",
  "greeting",
  "status",
]);

type StorageAccess = Pick<Storage, "getItem" | "setItem">;

export interface ServerNarrationEntry {
  seq: number;
  id: string;
  pair: string;
  kind: NarrationKind;
  occurredAt: number;
  json: { text: string } & Record<string, unknown>;
}

interface NarrationResponse {
  schema: 1;
  pair: string;
  entries: ServerNarrationEntry[];
  nextSince: number | null;
  hasMore: boolean;
}

export interface NarrationShadowDiagnostics {
  enabled: boolean;
  pair: string;
  cursor: number | null;
  fetched: number;
  cursorExpired: number;
  failures: number;
  serverOnly: number;
  deviceOnly: number;
  textMismatch: number;
  orderMismatch: number;
  cursorGap: number;
  cursorDuplicate: number;
  examples: string[];
  lastError: string | null;
}

export const emptyNarrationShadowDiagnostics = (
  pair: string,
  enabled = true,
): NarrationShadowDiagnostics => ({
  enabled,
  pair,
  cursor: null,
  fetched: 0,
  cursorExpired: 0,
  failures: 0,
  serverOnly: 0,
  deviceOnly: 0,
  textMismatch: 0,
  orderMismatch: 0,
  cursorGap: 0,
  cursorDuplicate: 0,
  examples: [],
  lastError: null,
});

function cursorKey(pair: string) {
  return `${CURSOR_KEY}:${pair}`;
}

export function shadowEnabled(storage: StorageAccess): boolean {
  try {
    return storage.getItem(NARRATION_SHADOW_ENABLED_KEY) !== "false";
  } catch {
    return false;
  }
}

export function restoreShadowCursor(
  storage: StorageAccess,
  pair: string,
): number | undefined {
  try {
    const raw = storage.getItem(cursorKey(pair));
    if (raw == null || raw === "") return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function persistShadowCursor(
  storage: StorageAccess,
  pair: string,
  cursor: number | undefined,
) {
  try {
    storage.setItem(cursorKey(pair), cursor == null ? "" : String(cursor));
  } catch {
    // Storage denial disables restart continuity, never the visible feed.
  }
}

function addExamples(previous: string[], next: string[]) {
  return [...previous, ...next].slice(-8);
}

export function compareNarrationPage(
  previous: NarrationShadowDiagnostics,
  server: readonly ServerNarrationEntry[],
  device: readonly NarrationEntry[],
  expectedAfter?: number,
): NarrationShadowDiagnostics {
  let cursorGap = 0;
  let cursorDuplicate = 0;
  const examples: string[] = [];
  let last = expectedAfter;
  for (const entry of server) {
    if (last != null && entry.seq <= last) {
      cursorDuplicate++;
      examples.push(`cursor duplicate: ${entry.seq} after ${last}`);
    } else if (last != null && entry.seq !== last + 1) {
      cursorGap++;
      examples.push(`cursor gap: ${last} -> ${entry.seq}`);
    }
    last = entry.seq;
  }

  const serverById = new Map(
    server.map((entry, index) => [entry.id, { entry, index }]),
  );
  const deviceById = new Map(
    device.map((entry, index) => [entry.id, { entry, index }]),
  );
  let serverOnly = 0;
  let deviceOnly = 0;
  let textMismatch = 0;
  let orderMismatch = 0;
  for (const item of server) {
    const local = deviceById.get(item.id);
    if (!local) {
      serverOnly++;
      examples.push(`server only: ${item.kind}/${item.id}`);
    } else if (local.entry.text !== item.json.text) {
      textMismatch++;
      examples.push(`text mismatch: ${item.kind}/${item.id}`);
    }
  }
  if (server.length) {
    const from = Math.min(...server.map((entry) => entry.occurredAt));
    const until = Math.max(...server.map((entry) => entry.occurredAt));
    const comparable = device.filter(
      (entry) =>
        !DEVICE_ONLY_KINDS.has(entry.kind) &&
        entry.at >= from &&
        entry.at <= until,
    );
    for (const item of comparable) {
      if (!serverById.has(item.id)) {
        deviceOnly++;
        examples.push(`device only: ${item.kind}/${item.id}`);
      }
    }
    const sharedInDeviceOrder = comparable
      .map((entry) => entry.id)
      .filter((id) => serverById.has(id));
    const sharedInServerOrder = server
      .map((entry) => entry.id)
      .filter((id) => deviceById.has(id));
    if (sharedInDeviceOrder.join("\n") !== sharedInServerOrder.join("\n")) {
      orderMismatch++;
      examples.push("order mismatch: shared ids are in a different order");
    }
  }
  return {
    ...previous,
    fetched: previous.fetched + server.length,
    serverOnly: previous.serverOnly + serverOnly,
    deviceOnly: previous.deviceOnly + deviceOnly,
    textMismatch: previous.textMismatch + textMismatch,
    orderMismatch: previous.orderMismatch + orderMismatch,
    cursorGap: previous.cursorGap + cursorGap,
    cursorDuplicate: previous.cursorDuplicate + cursorDuplicate,
    examples: addExamples(previous.examples, examples),
    lastError: null,
  };
}

export class NarrationShadowReader {
  private cursor: number | undefined;
  private diagnostics: NarrationShadowDiagnostics;

  constructor(
    private api: SettingsApi,
    private pair: string,
    private storage: StorageAccess,
  ) {
    this.cursor = restoreShadowCursor(storage, pair);
    this.diagnostics = {
      ...emptyNarrationShadowDiagnostics(pair, shadowEnabled(storage)),
      cursor: this.cursor ?? null,
    };
  }

  snapshot() {
    return this.diagnostics;
  }

  async poll(device: readonly NarrationEntry[]) {
    if (!shadowEnabled(this.storage)) {
      this.diagnostics = { ...this.diagnostics, enabled: false };
      return this.diagnostics;
    }
    this.diagnostics = { ...this.diagnostics, enabled: true };
    let recoveredExpired = false;
    for (;;) {
      const since = this.cursor == null ? "" : `&since=${this.cursor}`;
      let response: NarrationResponse;
      try {
        response = (await this.api(
          `narration?pair=${encodeURIComponent(this.pair)}${since}&limit=100`,
        )) as NarrationResponse;
        if (
          response?.schema !== 1 ||
          response.pair !== this.pair ||
          !Array.isArray(response.entries) ||
          typeof response.hasMore !== "boolean"
        )
          throw new Error("NARRATION_RESPONSE_INVALID");
      } catch (error) {
        const code = error instanceof Error ? error.message : "UNKNOWN";
        if (code === "NARRATION_CURSOR_EXPIRED" && !recoveredExpired) {
          recoveredExpired = true;
          this.cursor = undefined;
          persistShadowCursor(this.storage, this.pair, undefined);
          this.diagnostics = {
            ...this.diagnostics,
            cursor: null,
            cursorExpired: this.diagnostics.cursorExpired + 1,
            examples: addExamples(this.diagnostics.examples, [
              "cursor expired: latest window reloaded",
            ]),
          };
          continue;
        }
        this.diagnostics = {
          ...this.diagnostics,
          failures: this.diagnostics.failures + 1,
          lastError: code,
          examples: addExamples(this.diagnostics.examples, [
            `API failure: ${code}`,
          ]),
        };
        return this.diagnostics;
      }
      const before = this.cursor;
      this.diagnostics = compareNarrationPage(
        this.diagnostics,
        response.entries,
        device,
        before,
      );
      if (response.nextSince != null) {
        this.cursor = response.nextSince;
        persistShadowCursor(this.storage, this.pair, this.cursor);
      }
      this.diagnostics = { ...this.diagnostics, cursor: this.cursor ?? null };
      if (!response.hasMore) return this.diagnostics;
    }
  }
}

export function useNarrationShadow(
  api: SettingsApi | undefined,
  pair: string | undefined,
  entries: readonly NarrationEntry[],
  onDiagnostics?: (diagnostics: NarrationShadowDiagnostics) => void,
) {
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const [diagnostics, setDiagnostics] = useState(() =>
    emptyNarrationShadowDiagnostics(pair ?? "SUI_USDC"),
  );
  useEffect(() => {
    if (!api || !pair) return;
    const reader = new NarrationShadowReader(api, pair, window.localStorage);
    let alive = true;
    let timer: number | undefined;
    let failures = 0;
    const poll = async () => {
      const result = await reader.poll(entriesRef.current);
      if (!alive) return;
      failures = result.lastError ? failures + 1 : 0;
      setDiagnostics(result);
      onDiagnostics?.(result);
      timer = window.setTimeout(
        () => void poll(),
        result.enabled
          ? Math.min(NARRATION_SHADOW_POLL_MS * 2 ** failures, MAX_BACKOFF_MS)
          : NARRATION_SHADOW_POLL_MS,
      );
    };
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [api, pair, onDiagnostics]);
  return diagnostics;
}
