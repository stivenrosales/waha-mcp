import Anthropic from "@anthropic-ai/sdk";
import { LlmRejectedError, LlmUnavailableError } from "../../domain/errors.js";
import type {
  LlmClient,
  LlmTurnRequest,
  LlmTurnResult,
  LlmUsage,
} from "../../domain/ports/LlmClient.js";

/** OpenRouter's Anthropic-compatible root; the SDK appends `/v1/messages`. */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/**
 * OpenRouter-only routing field: Anthropic serves first, other Haiku providers only when it
 * fails. Not part of the SDK's types; `messages.create` forwards every param it does not
 * consume into the JSON body, so it reaches the wire as a sibling of `model`.
 */
const PROVIDER_ROUTING = { order: ["anthropic"], allow_fallbacks: true } as const;

/** Per-request ceiling; a slower answer surfaces as `LlmUnavailableError`. */
const REQUEST_TIMEOUT_MS = 90_000;

/** Timeouts (408) and client-closed requests (499) are transient, like 429 and 5xx. */
const RETRYABLE_4XX = new Set([408, 429, 499]);

type OpenRouterParams = Anthropic.MessageCreateParamsNonStreaming & {
  provider: typeof PROVIDER_ROUTING;
};

/**
 * Claude via OpenRouter's `/api/v1/messages` (Anthropic Messages format). Never sends
 * `temperature`, `top_p` or `top_k`, never retries (the engine owns retries) and never logs.
 */
export function createOpenRouterClaude(opts: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}): LlmClient {
  const client = new Anthropic({
    baseURL: OPENROUTER_BASE_URL,
    // Bearer auth with the OpenRouter key; `apiKey: null` keeps the SDK from adding X-Api-Key
    // or reading ANTHROPIC_API_KEY from the environment.
    apiKey: null,
    authToken: opts.apiKey,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
    // Explicit, so ANTHROPIC_LOG can never make the SDK log prompts, keys or provider bodies.
    logLevel: "off",
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return {
    async turn(q: LlmTurnRequest): Promise<LlmTurnResult> {
      const params: OpenRouterParams = {
        model: opts.model,
        max_tokens: q.maxTokens,
        // The mission's system prompt never changes: cache it (reads work through OpenRouter).
        system: [{ type: "text", text: q.system, cache_control: { type: "ephemeral" } }],
        messages: q.messages,
        ...(q.tools.length > 0 ? { tools: q.tools, tool_choice: { type: "auto" as const } } : {}),
        output_config: { effort: q.effort },
        provider: PROVIDER_ROUTING,
      };
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(params);
      } catch (err) {
        throw toDomainError(err);
      }
      return {
        content: message.content,
        stopReason: message.stop_reason ?? "unknown",
        usage: toUsage(message.usage),
      };
    },
  };
}

/** OpenRouter adds `usage.cost` (USD) to the Anthropic usage object. */
function toUsage(usage: Anthropic.Usage): LlmUsage {
  const cost = (usage as Anthropic.Usage & { cost?: unknown }).cost;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
  };
}

/**
 * Typed SDK errors only; the provider's message and body are always dropped (they may echo
 * input). Anything else (abort, unparseable body) becomes a fixed-text `LlmRejectedError`.
 */
function toDomainError(err: unknown): Error {
  if (err instanceof Anthropic.APIConnectionError) return new LlmUnavailableError(null);
  if (err instanceof Anthropic.InternalServerError) return new LlmUnavailableError(err.status);
  if (err instanceof Anthropic.APIError && typeof err.status === "number")
    return RETRYABLE_4XX.has(err.status) || err.status >= 500
      ? new LlmUnavailableError(err.status)
      : new LlmRejectedError(err.status);
  return new LlmRejectedError();
}
