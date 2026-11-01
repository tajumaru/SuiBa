/**
 * The narration character's user-chosen name. Device-local
 * (the character belongs to the viewer, not to a pair or the
 * bot), stored beside — but separate from — the narration
 * record. An empty name renders as the plain default キャラ.
 */

export const AGENT_NAME_KEY = "suiba.agentName";
export const AGENT_NAME_MAX = 10;
export const DEFAULT_AGENT_NAME = "キャラ";

/** Trim, drop control/newline characters, cap the length. */
export function sanitizeAgentName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, AGENT_NAME_MAX).join("");
}

export function agentDisplayName(name: string): string {
  return name === "" ? DEFAULT_AGENT_NAME : name;
}

interface NameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): NameStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadAgentName(
  storage: NameStorage | null = defaultStorage(),
): string {
  if (!storage) return "";
  try {
    return sanitizeAgentName(storage.getItem(AGENT_NAME_KEY) ?? "");
  } catch {
    return "";
  }
}

export function saveAgentName(
  name: string,
  storage: NameStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(AGENT_NAME_KEY, sanitizeAgentName(name));
  } catch {
    // A full/blocked storage must never break the shell.
  }
}
