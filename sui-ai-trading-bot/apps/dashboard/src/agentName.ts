/**
 * The narration character's user-chosen name. Device-local
 * (the character belongs to the viewer, not to a pair or the
 * bot), stored beside — but separate from — the narration
 * record. An empty name renders as the character's default:
 * キャラ for the white character, ぺんちゃん for the penguin.
 */

import {
  FIZH_DEFAULT_NAME,
  PEN_DEFAULT_NAME,
  type AgentCharacter,
} from "./agentCharacter.ts";

export const AGENT_NAME_KEY = "suiba.agentName";
export const AGENT_NAME_MAX = 10;
export const DEFAULT_AGENT_NAME = "キャラ";

/** Trim, drop control/newline characters, cap the length. */
export function sanitizeAgentName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, AGENT_NAME_MAX).join("");
}

export function agentDisplayName(
  name: string,
  character: AgentCharacter = "white",
): string {
  if (name !== "") return name;
  // ぺんちゃん and King Fizh arrive with names of their own;
  // the white character stays the plain キャラ until it is
  // renamed.
  if (character === "pen") return PEN_DEFAULT_NAME;
  if (character === "fizh") return FIZH_DEFAULT_NAME;
  return DEFAULT_AGENT_NAME;
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
