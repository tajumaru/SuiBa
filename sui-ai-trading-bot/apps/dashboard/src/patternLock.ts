/**
 * Pattern lock: a convenience lock for THIS device only.
 *
 * The real credential stays the management token. After a normal
 * token login the reader may enrol a 3x3 trace pattern; the token
 * is then encrypted with a key derived from the pattern
 * (PBKDF2 → AES-GCM, WebCrypto) and the ciphertext — never the
 * token, never the pattern — is kept in this browser's local
 * storage. On the next visit the pattern decrypts the token
 * locally and the login proceeds exactly like a typed-token
 * login (the server still verifies the token itself).
 *
 * This is deliberately a light lock: a pattern carries only a
 * few characters' worth of entropy, so the copy around it calls
 * it a 簡易ロック and the token form always remains available.
 * Nothing here talks to the worker; storage and crypto are
 * injectable so the logic is testable outside a browser.
 */

export const PATTERN_MIN_LENGTH = 4;
export const PATTERN_MAX_LENGTH = 9;

const STORAGE_KEY = "suiba.patternLock.v1";
const DISMISSED_KEY = "suiba.patternLock.dismissed";
const PBKDF2_ITERATIONS = 120_000;

/**
 * Android-style skip rule: tracing from one dot straight over
 * an untouched middle dot includes the middle dot first.
 * Keys are "from,to" dot indexes (row-major 0..8).
 */
const MIDPOINT: Readonly<Record<string, number>> = {
  "0,2": 1,
  "2,0": 1,
  "0,6": 3,
  "6,0": 3,
  "6,8": 7,
  "8,6": 7,
  "2,8": 5,
  "8,2": 5,
  "0,8": 4,
  "8,0": 4,
  "2,6": 4,
  "6,2": 4,
  "1,7": 4,
  "7,1": 4,
  "3,5": 4,
  "5,3": 4,
};

/** Append a dot to a traced sequence, applying the skip rule. */
export function appendPatternDot(
  sequence: readonly number[],
  dot: number,
): number[] {
  if (!Number.isInteger(dot) || dot < 0 || dot > 8) return [...sequence];
  if (sequence.includes(dot)) return [...sequence];
  const next = [...sequence];
  const last = next[next.length - 1];
  if (last !== undefined) {
    const mid = MIDPOINT[`${last},${dot}`];
    if (mid !== undefined && !next.includes(mid)) next.push(mid);
  }
  next.push(dot);
  return next;
}

export function isValidPattern(sequence: readonly number[]): boolean {
  return (
    sequence.length >= PATTERN_MIN_LENGTH &&
    sequence.length <= PATTERN_MAX_LENGTH &&
    sequence.every((d) => Number.isInteger(d) && d >= 0 && d <= 8) &&
    new Set(sequence).size === sequence.length
  );
}

/** Stable string form of a pattern, used as the key material input. */
export function patternKey(sequence: readonly number[]): string {
  return sequence.join("-");
}

export interface PatternLockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PatternLockEnv {
  storage?: PatternLockStorage | null;
  crypto?: Crypto | null;
}

interface EnrollmentRecord {
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

function defaultStorage(): PatternLockStorage | null {
  try {
    const s = (globalThis as { localStorage?: PatternLockStorage })
      .localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function defaultCrypto(): Crypto | null {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c?.subtle ? c : null;
}

function resolveEnv(env?: PatternLockEnv): {
  storage: PatternLockStorage | null;
  crypto: Crypto | null;
} {
  return {
    storage: env?.storage !== undefined ? env.storage : defaultStorage(),
    crypto: env?.crypto !== undefined ? env.crypto : defaultCrypto(),
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function loadEnrollment(
  env?: PatternLockEnv,
): EnrollmentRecord | null {
  const { storage } = resolveEnv(env);
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EnrollmentRecord>;
    if (
      parsed.v !== 1 ||
      typeof parsed.salt !== "string" ||
      typeof parsed.iv !== "string" ||
      typeof parsed.data !== "string"
    )
      return null;
    return parsed as EnrollmentRecord;
  } catch {
    return null;
  }
}

export function isEnrolled(env?: PatternLockEnv): boolean {
  return loadEnrollment(env) !== null;
}

export function isDismissed(env?: PatternLockEnv): boolean {
  const { storage } = resolveEnv(env);
  try {
    return storage?.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDismissed(env?: PatternLockEnv): void {
  const { storage } = resolveEnv(env);
  try {
    storage?.setItem(DISMISSED_KEY, "1");
  } catch {
    // A storage that refuses writes simply keeps offering.
  }
}

export function clearDismissed(env?: PatternLockEnv): void {
  const { storage } = resolveEnv(env);
  try {
    storage?.removeItem(DISMISSED_KEY);
  } catch {
    // Nothing to clear against a refusing storage.
  }
}

export function clearEnrollment(env?: PatternLockEnv): void {
  const { storage } = resolveEnv(env);
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear against a refusing storage.
  }
}

/**
 * Whether the pattern lock can run here at all: WebCrypto for
 * the encryption and a writable storage to keep the ciphertext.
 */
export function isPatternLockSupported(env?: PatternLockEnv): boolean {
  const { storage, crypto } = resolveEnv(env);
  if (!storage || !crypto?.subtle) return false;
  try {
    const probe = "suiba.patternLock.probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

async function deriveKey(
  crypto: Crypto,
  sequence: readonly number[],
  salt: Uint8Array,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`suiba-pattern-v1:${patternKey(sequence)}`),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt the token under the pattern and store the ciphertext
 * on this device. Throws when the platform cannot support it;
 * callers gate on isPatternLockSupported first.
 */
export async function enrollPattern(
  sequence: readonly number[],
  token: string,
  env?: PatternLockEnv,
): Promise<void> {
  if (!isValidPattern(sequence)) throw new Error("INVALID_PATTERN");
  const { storage, crypto } = resolveEnv(env);
  if (!storage || !crypto?.subtle) throw new Error("UNSUPPORTED");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(crypto, sequence, salt);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(token),
  );
  const record: EnrollmentRecord = {
    v: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(cipher)),
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(record));
}

/**
 * Try to recover the stored token with a traced pattern.
 * Returns null for a wrong pattern (AES-GCM refuses) and for
 * any missing or corrupt enrollment — never throws.
 */
export async function unlockWithPattern(
  sequence: readonly number[],
  env?: PatternLockEnv,
): Promise<string | null> {
  const { crypto } = resolveEnv(env);
  const record = loadEnrollment(env);
  if (!record || !crypto?.subtle) return null;
  try {
    const key = await deriveKey(
      crypto,
      sequence,
      fromBase64(record.salt),
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(record.iv) as BufferSource },
      key,
      fromBase64(record.data) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
