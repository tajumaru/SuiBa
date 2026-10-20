import { AsyncLocalStorage } from "node:async_hooks";
import { apiFetch, rawFetch } from "./api.ts";
const sdkContext = new AsyncLocalStorage<boolean>();
let originalFetch: typeof fetch | undefined;
// The SDK has no fetch injection and converts HTTP errors to route errors.
// Scope interception to its async call tree; other fetch users are untouched.
export function sdkRequests<T>(fn: () => Promise<T>): Promise<T> {
  if (!originalFetch) {
    originalFetch = rawFetch;
    globalThis.fetch = (input, init) =>
      sdkContext.getStore()
        ? apiFetch("Cetus", input, init)
        : originalFetch!(input, init);
  }
  return sdkContext.run(true, fn);
}
