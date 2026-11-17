/** Safe codes only: never retain a provider message, HTTP body, cause or key. */
export const shadowAdapterErrorCodes = [
  "SHADOW_API_KEY_MISSING",
  "OPENAI_AUTH_FAILED",
  "OPENAI_RATE_LIMITED",
  "OPENAI_HTTP_ERROR",
  "OPENAI_NETWORK_FAILED",
  "OPENAI_REFUSAL",
  "OPENAI_INCOMPLETE",
  "OPENAI_RESPONSE_FAILED",
  "OPENAI_INVALID_RESPONSE",
  "INVALID_JSON",
  "INVALID_SCHEMA",
  "INVALID_REFERENCE",
  "TIMEOUT",
  "CREDENTIAL_IN_OUTPUT",
] as const;
export type ShadowAdapterErrorCode = (typeof shadowAdapterErrorCodes)[number];
export class ShadowAdapterError extends Error {
  constructor(readonly code: ShadowAdapterErrorCode) {
    super(code);
    this.name = "ShadowAdapterError";
  }
}
