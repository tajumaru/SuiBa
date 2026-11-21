import { useEffect, useRef, useState } from "react";
import type { NarrationEntry } from "./agentNarration.ts";
import { trimNarrationEntries } from "./agentNarration.ts";
import {
  DEVICE_ONLY_KINDS,
  NARRATION_SHADOW_POLL_MS,
  type ServerNarrationEntry,
} from "./narrationShadow.ts";
import type { SettingsApi } from "./settingsPresets.ts";

export const NARRATION_SERVER_DISPLAY_ENABLED_KEY =
  "suiba.narration.server-display.enabled";
const DISPLAY_CURSOR_KEY = "suiba.narration.server-display.cursor.v1";
const MAX_BACKOFF_MS = 60_000;

type StorageAccess = Pick<Storage, "getItem" | "setItem">;
type NarrationResponse = {
  schema: 1;
  pair: string;
  entries: ServerNarrationEntry[];
  nextSince: number | null;
  hasMore: boolean;
};

export function serverDisplayEnabled(storage: Pick<Storage, "getItem">) {
  try {
    return storage.getItem(NARRATION_SERVER_DISPLAY_ENABLED_KEY) !== "false";
  } catch {
    return false;
  }
}

const cursorKey = (pair: string) => `${DISPLAY_CURSOR_KEY}:${pair}`;

function persistCursor(storage: StorageAccess, pair: string, cursor: number) {
  try {
    storage.setItem(cursorKey(pair), String(cursor));
  } catch {
    // A denied localStorage only loses restart continuity, not the feed.
  }
}

export function serverEntryToNarration(
  entry: ServerNarrationEntry,
): NarrationEntry {
  return {
    ...entry.json,
    id: entry.id,
    at: entry.occurredAt,
    kind: entry.kind,
    text: entry.json.text,
  } as NarrationEntry;
}

export function selectDisplayEntries(
  deviceEntries: readonly NarrationEntry[],
  serverEntries: readonly ServerNarrationEntry[],
  enabled: boolean,
): NarrationEntry[] {
  if (!enabled) return [...deviceEntries];
  const serverBossEvents = new Set(
    serverEntries.map((entry) => `${entry.kind}:${entry.occurredAt}`),
  );
  const deviceOnly = deviceEntries.filter((entry) =>
    DEVICE_ONLY_KINDS.has(entry.kind) ||
    ((entry.kind === "bossStart" || entry.kind === "bossEnd") &&
      !serverBossEvents.has(`${entry.kind}:${entry.at}`)),
  );
  return trimNarrationEntries(
    [...serverEntries.map(serverEntryToNarration), ...deviceOnly].sort(
      (a, b) => a.at - b.at || a.id.localeCompare(b.id),
    ),
  );
}

export function useNarrationServerDisplay(
  api: SettingsApi | undefined,
  pair: string | undefined,
) {
  const enabled =
    Boolean(api && pair) &&
    typeof window !== "undefined" &&
    serverDisplayEnabled(window.localStorage);
  const [serverEntries, setServerEntries] = useState<ServerNarrationEntry[]>(
    [],
  );
  const [initialLoadComplete, setInitialLoadComplete] = useState(!enabled);
  const cursorRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setServerEntries([]);
    cursorRef.current = undefined;
    setInitialLoadComplete(!enabled);
    if (!api || !pair || !enabled) return;
    let alive = true;
    let timer: number | undefined;
    let failures = 0;
    const poll = async () => {
      try {
        const since =
          cursorRef.current == null ? "" : `&since=${cursorRef.current}`;
        const response = (await api(
          `narration?pair=${encodeURIComponent(pair)}${since}&limit=100`,
        )) as NarrationResponse;
        if (
          response?.schema !== 1 ||
          response.pair !== pair ||
          !Array.isArray(response.entries) ||
          typeof response.hasMore !== "boolean"
        )
          throw new Error("NARRATION_RESPONSE_INVALID");
        if (!alive) return;
        failures = 0;
        setServerEntries((current) => {
          const byId = new Map(current.map((entry) => [entry.id, entry]));
          for (const entry of response.entries) byId.set(entry.id, entry);
          return [...byId.values()]
            .sort((a, b) => a.occurredAt - b.occurredAt || a.seq - b.seq)
            .slice(-100);
        });
        if (response.nextSince != null) {
          cursorRef.current = response.nextSince;
          persistCursor(window.localStorage, pair, response.nextSince);
        }
        setInitialLoadComplete(true);
        if (response.hasMore) {
          void poll();
          return;
        }
      } catch (error) {
        if (!alive) return;
        if (
          error instanceof Error &&
          error.message === "NARRATION_CURSOR_EXPIRED"
        ) {
          cursorRef.current = undefined;
        } else {
          failures++;
        }
      }
      timer = window.setTimeout(
        () => void poll(),
        Math.min(NARRATION_SHADOW_POLL_MS * 2 ** failures, MAX_BACKOFF_MS),
      );
    };
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [api, pair, enabled]);

  return { enabled, serverEntries, initialLoadComplete };
}
