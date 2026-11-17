import type Anthropic from "@anthropic-ai/sdk";

/** Tokens and cost of one LLM call, as the provider reported them (cost null when unknown). */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

/** One Messages API call: the full append-only history plus the tools Claude may use. */
export interface LlmTurnRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  effort: "low" | "medium";
  maxTokens: number;
}

export interface LlmTurnResult {
  content: Anthropic.ContentBlock[];
  stopReason: string;
  usage: LlmUsage;
}

/**
 * Port to the model. Throws `LlmUnavailableError` (retryable) or `LlmRejectedError`
 * (not retryable); it never retries by itself.
 */
export interface LlmClient {
  turn(q: LlmTurnRequest): Promise<LlmTurnResult>;
}
