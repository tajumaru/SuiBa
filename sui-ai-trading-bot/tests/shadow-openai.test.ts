import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { RuleBasedStrategy } from "../packages/strategy-engine/src/index.ts";
import { calculate } from "../packages/indicators/src/index.ts";
import type { Candle } from "../packages/shared/src/index.ts";
import { apiAccess } from "../packages/shared/src/api.ts";
import {
  ShadowRecorder,
  freezeSnapshot,
  shadowPrompt,
  SHADOW_PROMPT_VERSION,
  type ShadowInput,
} from "../apps/worker/src/shadow.ts";
import {
  OpenAIShadowAdapter,
  SHADOW_OPENAI_MODEL,
  SHADOW_OPENAI_SCHEMA,
  openAIUsage,
} from "../apps/worker/src/shadow-openai.ts";
const KEY = "sk-fixture-provider-secret-0123456789abcdefgh";
const dbs: BotDatabase[] = [];
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  vi.stubEnv("SUIBA_SHADOW_API_KEY", KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) db.close();
});
async function fixture() {
  const db = new BotDatabase(":memory:");
  dbs.push(db);
  const now = Date.now();
  const end = Math.floor(now / 300000) * 300 - 300;
  const candles: Candle[] = Array.from({ length: 70 }, (_, i) => ({
    timestamp: end - (69 - i) * 300,
    open: 2,
    high: 2.1,
    low: 1.9,
    close: 2,
    volume: 10,
    timeframe: 300,
    source: "fixture",
  }));
  const decision = await new RuleBasedStrategy(db.settings()).analyze({
    candles,
    current: calculate(candles),
    previous: calculate(candles.slice(0, -1)),
    entryPrice: null,
    now,
  });
  const input: ShadowInput = {
    cycleId: "shadow-0",
    pair: "SUI_USDC",
    now,
    candles,
    decision,
    portfolio: db.portfolio(),
    settings: db.settings(),
    market: null,
    healthy: true,
  };
  const snapshot = freezeSnapshot(input).snapshot;
  const controller = new AbortController();
  return {
    db,
    input,
    controller,
    request: {
      snapshot,
      prompt: shadowPrompt(snapshot),
      promptVersion: SHADOW_PROMPT_VERSION as typeof SHADOW_PROMPT_VERSION,
      signal: controller.signal,
    },
  };
}
const decision = () => ({
  action: "WAIT",
  confidence: 0.25,
  rationale: { refs: [], text: "記録専用の見送り" },
});
function response(patch: Record<string, unknown> = {}) {
  return {
    status: "completed",
    model: SHADOW_OPENAI_MODEL,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(decision()) }],
      },
    ],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 50 },
    },
    ...patch,
  };
}
const mockHTTP = (body: unknown = response(), status = 200) =>
  vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
it("sends fixed model, strict decision-only schema, no storage and minimum reasoning", async () => {
  const { request } = await fixture();
  const http = mockHTTP();
  const result = await new OpenAIShadowAdapter(http).complete(request);
  const [url, init] = http.mock.calls[0];
  const body = JSON.parse(String(init!.body));
  expect(url).toBe("https://api.openai.com/v1/responses");
  expect(init).toMatchObject({
    method: "POST",
    redirect: "error",
    signal: request.signal,
    headers: { Authorization: `Bearer ${KEY}` },
  });
  expect(body).toMatchObject({
    model: "gpt-5.4-nano",
    store: false,
    service_tier: "default",
    reasoning: { effort: "none" },
    max_output_tokens: 1024,
    text: {
      format: {
        type: "json_schema",
        strict: true,
        schema: SHADOW_OPENAI_SCHEMA,
      },
    },
  });
  expect(Object.keys(body.text.format.schema.properties)).toEqual([
    "action",
    "confidence",
    "rationale",
  ]);
  expect(body.input).toEqual([{ role: "user", content: request.prompt }]);
  expect(JSON.stringify(body)).not.toContain(KEY);
  expect(result).toMatchObject({
    ...decision(),
    model: SHADOW_OPENAI_MODEL,
    promptVersion: SHADOW_PROMPT_VERSION,
    usage: { inputTokens: 1000, outputTokens: 200, cost: 0.00045 },
  });
  expect(http).toHaveBeenCalledTimes(1);
});
it("strict schema closes every object, constrains refs and matches local rejection rules", async () => {
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (obj.type === "object") {
      expect(obj.additionalProperties).toBe(false);
      expect(obj.required).toEqual(Object.keys(obj.properties as object));
    }
    for (const v of Object.values(obj))
      if (Array.isArray(v)) v.forEach(visit);
      else visit(v);
  }
  visit(SHADOW_OPENAI_SCHEMA);
  const { request } = await fixture();
  for (const bad of [
    { ...decision(), action: "SELL" },
    { ...decision(), confidence: 1.1 },
    { ...decision(), rationale: { refs: [], text: "a".repeat(201) } },
    {
      ...decision(),
      rationale: {
        refs: Array(6).fill({ type: "candle", key: "close", value: 2 }),
        text: "bad",
      },
    },
    { ...decision(), model: "spoof" },
  ]) {
    const http = mockHTTP(
      response({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify(bad) }],
          },
        ],
      }),
    );
    await expect(
      new OpenAIShadowAdapter(http).complete(request),
    ).rejects.toMatchObject({ code: "INVALID_SCHEMA" });
  }
});
it("validates exact frozen ref observations, never repairs invented values", async () => {
  const { request } = await fixture();
  for (const value of [2, 99]) {
    const body = response({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                ...decision(),
                rationale: {
                  refs: [{ type: "candle", key: "close", value }],
                  text: "close",
                },
              }),
            },
          ],
        },
      ],
    });
    const result = new OpenAIShadowAdapter(mockHTTP(body)).complete(request);
    if (value === 2)
      await expect(result).resolves.toMatchObject({ action: "WAIT" });
    else
      await expect(result).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
  }
});
it("calculates USD from measured input/output, cache discounts and already-inclusive reasoning", () => {
  expect(openAIUsage({ input_tokens: 1000, output_tokens: 200 })).toEqual({
    inputTokens: 1000,
    outputTokens: 200,
    cost: 0.00045,
  });
  expect(
    openAIUsage({
      input_tokens: 1000,
      output_tokens: 200,
      input_tokens_details: { cached_tokens: 800 },
      output_tokens_details: { reasoning_tokens: 50 },
    }).cost,
  ).toBeCloseTo(0.000306, 12);
  expect(openAIUsage({ input_tokens: 0, output_tokens: 0 }).cost).toBe(0);
  for (const usage of [
    { input_tokens: 1 },
    { input_tokens: -1, output_tokens: 2 },
    { input_tokens: 1, output_tokens: NaN },
    { input_tokens: 1.5, output_tokens: 2 },
    {
      input_tokens: 2,
      output_tokens: 3,
      input_tokens_details: { cached_tokens: 3 },
    },
  ])
    expect(() => openAIUsage(usage)).toThrow("OPENAI_INVALID_RESPONSE");
});
it.each([
  [401, "OPENAI_AUTH_FAILED"],
  [403, "OPENAI_AUTH_FAILED"],
  [429, "OPENAI_RATE_LIMITED"],
  [400, "OPENAI_HTTP_ERROR"],
  [500, "OPENAI_HTTP_ERROR"],
  [503, "OPENAI_HTTP_ERROR"],
] as const)(
  "maps HTTP %s to %s without reading error bodies, retrying or affecting trading API state",
  async (status, code) => {
    const { request } = await fixture();
    const raw = Response.json(
      { error: { message: KEY, authorization: KEY.slice(5, 20) } },
      { status },
    );
    const read = vi.spyOn(raw, "json");
    const http = vi.fn<typeof fetch>().mockResolvedValue(raw);
    const before = apiAccess.snapshot();
    const error = await new OpenAIShadowAdapter(http)
      .complete(request)
      .catch((e) => e);
    if (!(error instanceof Error)) throw Error("Expected a safe adapter error");
    expect(error).toMatchObject({ code, message: code });
    expect(error.cause).toBeUndefined();
    expect(String(error.stack)).not.toContain(KEY);
    expect(read).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledTimes(1);
    expect(apiAccess.snapshot()).toEqual(before);
  },
);
it.each([
  [
    "OPENAI_REFUSAL",
    response({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: KEY }],
        },
      ],
    }),
  ],
  [
    "OPENAI_INCOMPLETE",
    response({ status: "incomplete", incomplete_details: { reason: KEY } }),
  ],
  [
    "OPENAI_RESPONSE_FAILED",
    response({ status: "failed", error: { message: KEY } }),
  ],
  ["OPENAI_INVALID_RESPONSE", response({ output: [] })],
  ["OPENAI_INVALID_RESPONSE", response({ usage: { input_tokens: 1 } })],
  ["OPENAI_INVALID_RESPONSE", response({ model: "unapproved-model" })],
  [
    "INVALID_JSON",
    response({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: KEY }],
        },
      ],
    }),
  ],
] as const)("maps %s into a safe reason code", async (code, body) => {
  const { request } = await fixture();
  const error = await new OpenAIShadowAdapter(mockHTTP(body))
    .complete(request)
    .catch((e) => e);
  if (!(error instanceof Error)) throw Error("Expected a safe adapter error");
  // A credential-containing body is rejected before even attempting JSON parsing.
  const expected = code === "INVALID_JSON" ? "CREDENTIAL_IN_OUTPUT" : code;
  expect(error).toMatchObject({ code: expected, message: expected });
  expect(JSON.stringify(error)).not.toContain(KEY);
  expect(String(error.stack)).not.toContain(KEY.slice(5, 20));
});
it("drops raw network and malformed-envelope errors instead of leaking key or fragments", async () => {
  const { request } = await fixture();
  const transport = vi
    .fn<typeof fetch>()
    .mockRejectedValue(
      new Error(KEY.slice(5, 20), { cause: { Authorization: KEY } }),
    );
  await expect(
    new OpenAIShadowAdapter(transport).complete(request),
  ).rejects.toMatchObject({
    code: "OPENAI_NETWORK_FAILED",
    message: "OPENAI_NETWORK_FAILED",
  });
  const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response(KEY));
  await expect(
    new OpenAIShadowAdapter(malformed).complete(request),
  ).rejects.toMatchObject({ code: "OPENAI_INVALID_RESPONSE" });
});
it.each([KEY, KEY.slice(5, 20)])(
  "rejects credential echoes before any record or log",
  async (text) => {
    const { db, input } = await fixture();
    const body = response({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                ...decision(),
                rationale: { refs: [], text },
              }),
            },
          ],
        },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {}),
      error = vi.spyOn(console, "error").mockImplementation(() => {}),
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new ShadowRecorder(
      db,
      new OpenAIShadowAdapter(mockHTTP(body)),
      () => true,
    ).offer(() => input);
    await turn();
    await turn();
    const rows = db.history<{ status: string; reasonCode: string }>(
      "shadow_decisions",
    );
    expect(rows[0]).toMatchObject({
      status: "ERROR",
      reasonCode: "CREDENTIAL_IN_OUTPUT",
    });
    expect(JSON.stringify(rows)).not.toContain(text);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  },
);
it("missing key records one safe ERROR then quietly stops shadow only, without HTTP or budget", async () => {
  vi.stubEnv("SUIBA_SHADOW_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", KEY);
  const { db, input } = await fixture();
  const http = mockHTTP();
  const adapter = new OpenAIShadowAdapter(http);
  const before = [db.settings(), db.runtime(), db.portfolio()];
  const recorder = new ShadowRecorder(db, adapter, () => true);
  recorder.offer(() => input);
  await turn();
  await turn();
  input.now += 86400000;
  input.cycleId = "another";
  const read = vi.fn(() => input);
  recorder.offer(read);
  new ShadowRecorder(db, adapter, () => true).offer(read);
  await turn();
  expect(read).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
  expect(db.shadowLastCall()).toBeNull();
  expect(db.history("shadow_decisions")).toEqual([
    expect.objectContaining({
      status: "ERROR",
      reasonCode: "SHADOW_API_KEY_MISSING",
    }),
  ]);
  expect([db.settings(), db.runtime(), db.portfolio()]).toEqual(before);
});
it("OFF never checks readiness, evaluates/freeze inputs or invokes a configured adapter", () => {
  const http = mockHTTP(),
    adapter = new OpenAIShadowAdapter(http),
    readiness = vi.spyOn(adapter, "readiness"),
    input = vi.fn(() => {
      throw Error("unexpected");
    });
  new ShadowRecorder(
    { append: vi.fn(), reserveShadowCall: vi.fn(), shadowLastCall: vi.fn() },
    adapter,
    () => false,
  ).offer(input);
  expect(input).not.toHaveBeenCalled();
  expect(readiness).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
});
it("S1 aborts at 30 seconds, preserves single flight, and never propagates HTTP delay to its caller", async () => {
  const { db, input } = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let signal: AbortSignal | undefined;
  const http = vi.fn<typeof fetch>().mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init!.signal as AbortSignal;
        signal.addEventListener(
          "abort",
          () => reject(Error(KEY.slice(5, 20))),
          { once: true },
        );
      }),
  );
  const recorder = new ShadowRecorder(
    db,
    new OpenAIShadowAdapter(http),
    () => true,
  );
  expect(() => recorder.offer(() => input)).not.toThrow();
  await turn();
  recorder.offer(() => input);
  expect(http).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(29999);
  expect(db.history("shadow_decisions")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal!.aborted).toBe(true);
  expect(db.history("shadow_decisions")).toEqual([
    expect.objectContaining({ status: "ERROR", reasonCode: "TIMEOUT" }),
  ]);
  expect(db.runtime().error).toBeNull();
});
it("persists real adapter output and cost with same-cycle id without modifying strategy decisions", async () => {
  const { db, input } = await fixture();
  db.recordAnalysis(
    input.cycleId,
    input.decision,
    calculate(input.candles),
    input.now,
  );
  const before = db.history("strategy_decisions");
  const http = mockHTTP(response({ model: "gpt-5.4-nano-2026-03-17" }));
  new ShadowRecorder(db, new OpenAIShadowAdapter(http), () => true).offer(
    () => input,
  );
  await turn();
  await turn();
  expect(db.history("shadow_decisions")).toEqual([
    expect.objectContaining({
      cycleId: input.cycleId,
      status: "OK",
      model: "gpt-5.4-nano",
      promptVersion: SHADOW_PROMPT_VERSION,
      usage: { inputTokens: 1000, outputTokens: 200, cost: 0.00045 },
    }),
  ]);
  expect(db.history("strategy_decisions")).toEqual(before);
});

it("maps invalid decision JSON without credential data to INVALID_JSON", async () => {
  const { request } = await fixture();
  const http = mockHTTP(
    response({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "not-json" }],
        },
      ],
    }),
  );
  await expect(
    new OpenAIShadowAdapter(http).complete(request),
  ).rejects.toMatchObject({ code: "INVALID_JSON" });
});

it("does not salvage a valid decision from a partially malformed provider output", async () => {
  const { request } = await fixture();
  const good = response().output[0];
  for (const broken of [
    { type: "message", role: "assistant" },
    { type: "function_call", name: "unexpected" },
  ]) {
    const http = mockHTTP(response({ output: [good, broken] }));
    await expect(
      new OpenAIShadowAdapter(http).complete(request),
    ).rejects.toMatchObject({ code: "OPENAI_INVALID_RESPONSE" });
  }
});

it("accepts boolean portfolio facts as well as numeric observations, matching S1", async () => {
  const { request } = await fixture();
  const body = response({
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              ...decision(),
              rationale: {
                text: "flat",
                refs: [{ type: "portfolio", key: "hasPosition", value: false }],
              },
            }),
          },
        ],
      },
    ],
  });
  await expect(
    new OpenAIShadowAdapter(mockHTTP(body)).complete(request),
  ).resolves.toMatchObject({
    rationale: {
      refs: [{ type: "portfolio", key: "hasPosition", value: false }],
    },
  });
});

it("rejects JSON-escaped credential fragments before recording the decoded text", async () => {
  const { db, input } = await fixture();
  const fragment = KEY.slice(5, 20);
  const escaped = Array.from(
    fragment,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  ).join("");
  const text = JSON.stringify({
    ...decision(),
    rationale: { refs: [], text: fragment },
  }).replace(fragment, escaped);
  const http = mockHTTP(
    response({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
    }),
  );
  new ShadowRecorder(db, new OpenAIShadowAdapter(http), () => true).offer(
    () => input,
  );
  await turn();
  await turn();
  expect(db.history("shadow_decisions")).toEqual([
    expect.objectContaining({
      status: "ERROR",
      reasonCode: "CREDENTIAL_IN_OUTPUT",
    }),
  ]);
  expect(JSON.stringify(db.history("shadow_decisions"))).not.toContain(
    fragment,
  );
});
