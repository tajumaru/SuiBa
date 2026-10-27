import { verifyToken } from "./verifyToken.ts";
import type { VerifyResult } from "./LoginScreen.tsx";

export const SESSION = "cookie-session";
export async function loginSession(
  candidate: string,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  const verified = await verifyToken(candidate, signal);
  if (!verified.ok) return verified;
  try {
    const response = await fetch("/api/auth/session", {
      method: "POST",
      signal,
      headers: { Authorization: "Bearer " + candidate, "X-SuiBa-Request": "1" },
      cache: "no-store",
    });
    return response.ok
      ? { ok: true }
      : { ok: false, code: `HTTP_${response.status}` };
  } catch {
    return { ok: false, code: signal?.aborted ? "CANCELLED" : "NETWORK" };
  }
}
