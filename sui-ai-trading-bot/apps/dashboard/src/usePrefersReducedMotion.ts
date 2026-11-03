import { useEffect, useState } from "react";

/**
 * The display's reduced-motion preference, read synchronously on
 * first render when a media query list is available (tests stub
 * it) and kept current through its change events. Components use
 * it to leave animated celebration marks out entirely under
 * reduce; style.css independently defines every animation only
 * under no-preference, so the two layers agree.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    onChange();
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}
