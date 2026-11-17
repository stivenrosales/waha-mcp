/** Tokens and cost of one LLM call, as the provider reported them (cost null when unknown). */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}
