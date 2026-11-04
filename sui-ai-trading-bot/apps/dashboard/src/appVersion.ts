import { useEffect, useState } from "react";

declare const __APP_BUILD__: string;
declare const __APP_SUBJECT__: string;

/** This page's build identity, stamped by vite at build time
 * (see vite.config.ts). "dev" outside a stamped build. */
export const APP_BUILD: string =
  typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "dev";
export const APP_SUBJECT: string =
  typeof __APP_SUBJECT__ === "string" ? __APP_SUBJECT__ : "";

export interface ServedVersion {
  build: string;
  subject: string;
  builtAt: string;
}

export function parseServedVersion(json: unknown): ServedVersion | null {
  if (typeof json !== "object" || json === null) return null;
  const v = json as Record<string, unknown>;
  if (typeof v.build !== "string" || v.build === "") return null;
  return {
    build: v.build,
    subject: typeof v.subject === "string" ? v.subject : "",
    builtAt: typeof v.builtAt === "string" ? v.builtAt : "",
  };
}

/** An update exists only when both sides carry a real build id
 * and they differ — a dev page or a missing version file must
 * never raise the banner. */
export function updateAvailable(
  current: string,
  served: ServedVersion | null,
): boolean {
  return (
    served !== null &&
    current !== "dev" &&
    served.build !== "dev" &&
    served.build !== current
  );
}

/** True only when the page's build and the worker's build are
 * both real stamps and differ — dev/unknown never counts as a
 * skew, so the warning cannot cry wolf. */
export function versionSkew(
  appBuild: string,
  workerBuildValue: string | null | undefined,
): boolean {
  if (!workerBuildValue) return false;
  if (appBuild === "dev" || appBuild === "unknown") return false;
  if (workerBuildValue === "dev" || workerBuildValue === "unknown")
    return false;
  return appBuild !== workerBuildValue;
}

export async function fetchServedVersion(
  fetcher: typeof fetch = fetch,
): Promise<ServedVersion | null> {
  try {
    const res = await fetcher("version.json", { cache: "no-store" });
    if (!res.ok) return null;
    return parseServedVersion(await res.json());
  } catch {
    return null;
  }
}

/** Polls the deployed version.json (and re-checks when the page
 * becomes visible again) and returns the newer build once one is
 * being served, or null while this page is current. */
export function useUpdateCheck(intervalMs = 60000): ServedVersion | null {
  const [served, setServed] = useState<ServedVersion | null>(null);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const v = await fetchServedVersion();
      if (alive) setServed(v);
    };
    void check();
    const timer = setInterval(() => void check(), intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
  return updateAvailable(APP_BUILD, served) ? served : null;
}
