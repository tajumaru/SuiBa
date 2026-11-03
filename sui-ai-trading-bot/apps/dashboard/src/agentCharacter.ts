/**
 * Which character the narration avatar wears: the original white
 * character, or ぺんちゃん — the pink penguin (pink hood, white
 * face and belly, big orange beak) added as a second cast member.
 * Device-local, like the character's name: the choice belongs to
 * the viewer, not to a pair or the bot. The white character is
 * the default, and anything unreadable falls back to it. Saving
 * notifies subscribers so every visible artwork swaps at once.
 */

import { useEffect, useState } from "react";

export type AgentCharacter = "white" | "pen";

export const AGENT_CHARACTER_KEY = "suiba.agentCharacter";

/** ぺんちゃん's own name, used while the user has not renamed
 * the character (see agentDisplayName). */
export const PEN_DEFAULT_NAME = "ぺんちゃん";

interface CharacterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): CharacterStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const listeners = new Set<(character: AgentCharacter) => void>();

export function loadAgentCharacter(
  storage: CharacterStorage | null = defaultStorage(),
): AgentCharacter {
  if (!storage) return "white";
  try {
    return storage.getItem(AGENT_CHARACTER_KEY) === "pen" ? "pen" : "white";
  } catch {
    return "white";
  }
}

export function saveAgentCharacter(
  character: AgentCharacter,
  storage: CharacterStorage | null = defaultStorage(),
): void {
  if (storage) {
    try {
      storage.setItem(AGENT_CHARACTER_KEY, character);
    } catch {
      // A full/blocked storage must never break the shell; the
      // in-memory subscribers below still swap the artwork.
    }
  }
  for (const listener of [...listeners]) listener(character);
}

export function subscribeAgentCharacter(
  listener: (character: AgentCharacter) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current character, live: re-renders when it is saved. */
export function useAgentCharacter(): AgentCharacter {
  const [character, setCharacter] = useState<AgentCharacter>(() =>
    loadAgentCharacter(),
  );
  useEffect(() => subscribeAgentCharacter(setCharacter), []);
  return character;
}
