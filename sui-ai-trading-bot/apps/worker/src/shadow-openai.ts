import { z } from "zod";
import {
  refKeys,
  shadowDecisionSchema,
  validateShadowOutput,
  type ShadowAdapter,
} from "./shadow.ts";
import { ShadowAdapterError } from "./shadow-errors.ts";
export const SHADOW_OPENAI_MODEL = "gpt-5.4-nano";
// Model changes require a code change AND SHADOW_PROMPT_VERSION bump.
// USD / 1M tokens, verified 2026-11-14:
// https://developers.openai.com/api/docs/models/gpt-5.4-nano
export const SHADOW_OPENAI_RATES = Object.freeze({
  input: 0.2,
  cachedInput: 0.02,
  output: 1.25,
});
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
/** Only model-authored fields. Host supplies identity, version and actual usage. */
export const SHADOW_OPENAI_SCHEMA = object({
  action: { type: "string", enum: ["BUY", "WAIT"] },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  rationale: object({
    refs: {
      type: "array",
      maxItems: 5,
      items: {
        anyOf: Object.entries(refKeys).map(([type, keys]) =>
          object({
            type: { type: "string", enum: [type] },
            key: { type: "string", enum: keys },
            // Match S1, including portfolio.hasPosition (boolean).
            value: { anyOf: [{ type: "number" }, { type: "boolean" }] },
          }),
        ),
      },
    },
    text: { type: "string", maxLength: 200 },
  }),
});
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z
  .object({
    input_tokens: count,
    output_tokens: count,
    input_tokens_details: z.object({ cached_tokens: count }).optional(),
  })
  .refine(
    (u) => (u.input_tokens_details?.cached_tokens ?? 0) <= u.input_tokens,
  );
export function openAIUsage(raw: unknown) {
  const result = usageSchema.safeParse(raw);
  if (!result.success) throw new ShadowAdapterError("OPENAI_INVALID_RESPONSE");
  const u = result.data,
    cached = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    // output_tokens already includes reasoning tokens; never add them twice.
    cost:
      ((u.input_tokens - cached) * SHADOW_OPENAI_RATES.input +
        cached * SHADOW_OPENAI_RATES.cachedInput +
        u.output_tokens * SHADOW_OPENAI_RATES.output) /
      1_000_000,
  };
}
const envelopeSchema = z.object({
  status: z.string(),
  model: z.string(),
  output: z.array(z.unknown()),
  usage: z.unknown(),
});
const messageSchema = z.object({
  type: z.literal("message"),
  role: z.literal("assistant"),
  status: z.literal("completed").optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
function rejectCredentialEcho(text: string, key: string) {
  for (let at = 0; at <= Math.max(0, key.length - 8); at++) {
    if (text.includes(key.slice(at, at + 8)))
      throw new ShadowAdapterError("CREDENTIAL_IN_OUTPUT");
  }
}
/** Native HTTP only: no shared ApiAccess, trading dispatcher, retries or logging.
 * The injected transport is for offline contracts; credentials are read only
 * from SUIBA_SHADOW_API_KEY at invocation and never retained as object state. */
export class OpenAIShadowAdapter implements ShadowAdapter {
  constructor(
    private readonly transport: typeof fetch = globalThis.fetch.bind(
      globalThis,
    ),
  ) {}
  readiness(): "SHADOW_API_KEY_MISSING" | null {
    return process.env.SUIBA_SHADOW_API_KEY?.trim()
      ? null
      : "SHADOW_API_KEY_MISSING";
  }
  async complete(
    request: Parameters<ShadowAdapter["complete"]>[0],
  ): Promise<unknown> {
    const key = process.env.SUIBA_SHADOW_API_KEY?.trim();
    if (!key) throw new ShadowAdapterError("SHADOW_API_KEY_MISSING");
    try {
      const response = await this.transport(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          redirect: "error",
          signal: request.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: SHADOW_OPENAI_MODEL,
            store: false,
            service_tier: "default", // Match the standard published rates above.
            reasoning: { effort: "none" },
            max_output_tokens: 1024,
            input: [{ role: "user", content: request.prompt }],
            text: {
              format: {
                type: "json_schema",
                name: "shadow_decision",
                strict: true,
                schema: SHADOW_OPENAI_SCHEMA,
              },
            },
          }),
        },
      );
      if (!response.ok) {
        // Never read or attach an error body (it may echo authorization).
        void response.body?.cancel().catch(() => {});
        throw new ShadowAdapterError(
          response.status === 401 || response.status === 403
            ? "OPENAI_AUTH_FAILED"
            : response.status === 429
              ? "OPENAI_RATE_LIMITED"
              : "OPENAI_HTTP_ERROR",
        );
      }
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new ShadowAdapterError(
          request.signal.aborted ? "TIMEOUT" : "OPENAI_INVALID_RESPONSE",
        );
      }
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success)
        throw new ShadowAdapterError("OPENAI_INVALID_RESPONSE");
      const data = parsed.data;
      if (data.status === "incomplete")
        throw new ShadowAdapterError("OPENAI_INCOMPLETE");
      if (data.status !== "completed")
        throw new ShadowAdapterError("OPENAI_RESPONSE_FAILED");
      // OpenAI may resolve the alias to a dated snapshot. Persist the fixed
      // requested model enum only, never arbitrary response model strings.
      if (
        data.model !== SHADOW_OPENAI_MODEL &&
        !(
          data.model.startsWith(SHADOW_OPENAI_MODEL) &&
          /^-\d{4}-\d{2}-\d{2}$/.test(
            data.model.slice(SHADOW_OPENAI_MODEL.length),
          )
        )
      )
        throw new ShadowAdapterError("OPENAI_INVALID_RESPONSE");
      const texts: string[] = [];
      for (const item of data.output) {
        const message = messageSchema.safeParse(item);
        if (!message.success) {
          // Reasoning items are provider metadata; malformed messages and
          // unexpected tool/output items must not be silently salvaged.
          if (
            z.object({ type: z.literal("reasoning") }).safeParse(item).success
          )
            continue;
          throw new ShadowAdapterError("OPENAI_INVALID_RESPONSE");
        }
        for (const content of message.data.content) {
          if (content.type === "refusal")
            throw new ShadowAdapterError("OPENAI_REFUSAL");
          if (content.type !== "output_text" || content.text === undefined)
            throw new ShadowAdapterError("OPENAI_INVALID_RESPONSE");
          texts.push(content.text);
        }
      }
      if (texts.length !== 1)
        throw new ShadowAdapterError("OPENAI_INVALID_RESPONSE");
      // Reject rather than redact/repair an echo of a key or meaningful fragment.
      rejectCredentialEcho(texts[0], key);
      let decision: unknown;
      try {
        decision = JSON.parse(texts[0]);
      } catch {
        throw new ShadowAdapterError("INVALID_JSON");
      }
      // Decode JSON escapes before the second check: a partial credential
      // encoded as \uXXXX must be rejected before it can reach a local record.
      rejectCredentialEcho(JSON.stringify(decision), key);
      const checked = shadowDecisionSchema.safeParse(decision);
      if (!checked.success) throw new ShadowAdapterError("INVALID_SCHEMA");
      const output = {
        ...checked.data,
        model: SHADOW_OPENAI_MODEL,
        promptVersion: request.promptVersion,
        usage: openAIUsage(data.usage),
      };
      try {
        return validateShadowOutput(output, request.snapshot);
      } catch (error) {
        throw new ShadowAdapterError(
          error instanceof Error && error.message === "INVALID_REFERENCE"
            ? "INVALID_REFERENCE"
            : "INVALID_SCHEMA",
        );
      }
    } catch (error) {
      // No raw network exception, cause, response, headers or key fragments.
      if (error instanceof ShadowAdapterError) throw error;
      throw new ShadowAdapterError(
        request.signal.aborted ? "TIMEOUT" : "OPENAI_NETWORK_FAILED",
      );
    }
  }
}
