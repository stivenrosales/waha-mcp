import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmRejectedError, LlmUnavailableError } from "../../../src/domain/errors.js";
import type { LlmTurnRequest } from "../../../src/domain/ports/LlmClient.js";
import { createOpenRouterClaude } from "../../../src/infrastructure/llm/openRouterClaude.js";

const KEY = "sk-or-very-secret";
const MODEL = "anthropic/claude-haiku-5.5";

/** In-process OpenRouter: records each request and answers with `respond`. */
function fakeOpenRouter(respond: (req: Request) => Response | Promise<Response>) {
  const seen: { req: Request; body: Record<string, unknown> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = JSON.parse(await req.clone().text()) as Record<string, unknown>;
    seen.push({ req, body });
    return respond(req);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const message = (usage: Record<string, unknown>) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [{ type: "text", text: "Hola" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage,
});

const turn: LlmTurnRequest = {
  system: "You are the owner's assistant.",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  effort: "medium",
  maxTokens: 4000,
};

const usage = {
  input_tokens: 120,
  output_tokens: 30,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 20,
};

describe("OpenRouter Claude client", () => {
  it("POSTs to https://openrouter.ai/api/v1/messages with the bearer key and the agreed body", async () => {
    const p = fakeOpenRouter(() => json(message({ ...usage, cost: 0.0012 })));
    const llm = createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: p.fetch });
    const tools = [
      {
        name: "send_message",
        description: "Send a WhatsApp message.",
        input_schema: { type: "object" as const, properties: { text: { type: "string" } } },
      },
    ];
    await llm.turn({ ...turn, tools });

    expect(p.seen).toHaveLength(1);
    const { req, body } = p.seen[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://openrouter.ai/api/v1/messages");
    expect(req.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(req.headers.get("x-api-key")).toBeNull();
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(4000);
    // The system prompt is stable for a mission: one cache breakpoint on it (spike §3.4).
    expect(body.system).toEqual([
      { type: "text", text: turn.system, cache_control: { type: "ephemeral" } },
    ]);
    expect(body.messages).toEqual(turn.messages);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.provider).toEqual({ order: ["anthropic"], allow_fallbacks: true });
    expect((body.provider as { order: string[] }).order[0]).toBe("anthropic");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
  });

  it("omits tools and tool_choice when no tools are given", async () => {
    const p = fakeOpenRouter(() => json(message(usage)));
    const llm = createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: p.fetch });
    await llm.turn({ ...turn, effort: "low" });
    const { body } = p.seen[0];
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("returns content and stop reason, and maps usage.cost 0.0012 to costUsd 0.0012", async () => {
    const p = fakeOpenRouter(() => json(message({ ...usage, cost: 0.0012 })));
    const llm = createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: p.fetch });
    const result = await llm.turn(turn);
    expect(result.content).toEqual([{ type: "text", text: "Hola" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      costUsd: 0.0012,
    });
  });

  it("maps a missing or non-number cost to null and missing cache counts to 0", async () => {
    for (const u of [
      { input_tokens: 5, output_tokens: 1 },
      { input_tokens: 5, output_tokens: 1, cost: "0.1" },
    ]) {
      const p = fakeOpenRouter(() => json(message(u)));
      const llm = createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: p.fetch });
      expect((await llm.turn(turn)).usage).toEqual({
        inputTokens: 5,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
      });
    }
  });

  it("a 500 throws LlmUnavailableError without retrying", async () => {
    const p = fakeOpenRouter(() => json({ error: { message: `boom ${KEY}` } }, 500));
    const llm = createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: p.fetch });
    const err = await llm.turn(turn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as LlmUnavailableError).status).toBe(500);
    expect((err as Error).message).not.toContain(KEY);
    expect(p.seen).toHaveLength(1);
  });

  it("a 429 or a network failure throws LlmUnavailableError", async () => {
    const limited = fakeOpenRouter(() => json({ error: { message: "slow down" } }, 429));
    await expect(
      createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: limited.fetch }).turn(turn),
    ).rejects.toBeInstanceOf(LlmUnavailableError);

    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const err = await createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: down })
      .turn(turn)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as LlmUnavailableError).status).toBeNull();
  });

  it("other 4xx throw LlmRejectedError with the status and never the provider body", async () => {
    for (const status of [400, 401, 402, 404]) {
      const p = fakeOpenRouter(() => json({ error: { message: `bad request ${KEY}` } }, status));
      const err = await createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: p.fetch })
        .turn(turn)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmRejectedError);
      expect((err as LlmRejectedError).status).toBe(status);
      expect((err as Error).message).not.toContain(KEY);
      expect((err as Error).message).not.toContain("bad request");
    }
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("never logs, even with ANTHROPIC_LOG=debug", async () => {
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    const spies = (["log", "debug", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const ok = fakeOpenRouter(() => json(message(usage)));
    await createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: ok.fetch }).turn(turn);
    const failing = fakeOpenRouter(() => json({ error: { message: "nope" } }, 400));
    await createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: failing.fetch })
      .turn(turn)
      .catch(() => {});
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("times out after 90 s with LlmUnavailableError", async () => {
    vi.useFakeTimers();
    const hang = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as typeof globalThis.fetch;
    let settled: unknown;
    const pending = createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: hang })
      .turn(turn)
      .then(
        () => {
          settled = "resolved";
        },
        (e: unknown) => {
          settled = e;
        },
      );
    await vi.advanceTimersByTimeAsync(89_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(settled).toBeInstanceOf(LlmUnavailableError);
    expect((settled as LlmUnavailableError).status).toBeNull();
  });

  it("408 and 499 throw LlmUnavailableError; 409 stays LlmRejectedError", async () => {
    for (const status of [408, 499]) {
      const p = fakeOpenRouter(() => json({ error: { message: "later" } }, status));
      const err = await createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: p.fetch })
        .turn(turn)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmUnavailableError);
      expect((err as LlmUnavailableError).status).toBe(status);
    }
    const conflict = fakeOpenRouter(() => json({ error: { message: "conflict" } }, 409));
    const err = await createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: conflict.fetch })
      .turn(turn)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRejectedError);
    expect((err as LlmRejectedError).status).toBe(409);
  });

  it("a malformed 2xx body throws LlmRejectedError 'Unexpected LLM client error.' without the body", async () => {
    const p = fakeOpenRouter(
      () =>
        new Response(`{"oops": "${KEY} provider said`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const err = await createOpenRouterClaude({ apiKey: KEY, model: MODEL, fetch: p.fetch })
      .turn(turn)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRejectedError);
    expect((err as Error).message).toBe("Unexpected LLM client error.");
    expect((err as LlmRejectedError).status).toBeUndefined();
  });
});
