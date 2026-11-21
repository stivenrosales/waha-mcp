import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { type ContextLine, composeScheduled } from "../../../src/application/schedules/compose.js";
import { MAX_TEXT_CHARS } from "../../../src/application/send.js";
import type {
  LlmClient,
  LlmTurnRequest,
  LlmTurnResult,
} from "../../../src/domain/ports/LlmClient.js";
import { formatLocal } from "../../../src/domain/schedules/recurrence.js";

const usage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

const block = (b: Record<string, unknown>) => b as unknown as Anthropic.ContentBlock;
const decide = (input: unknown) =>
  block({ type: "tool_use", id: "toolu_1", name: "decide", input });
const result = (...content: Anthropic.ContentBlock[]): LlmTurnResult => ({
  content,
  stopReason: "tool_use",
  usage,
});

class FakeLlm implements LlmClient {
  requests: LlmTurnRequest[] = [];
  constructor(private reply: LlmTurnResult) {}
  async turn(q: LlmTurnRequest): Promise<LlmTurnResult> {
    this.requests.push(structuredClone(q));
    return this.reply;
  }
}

const NOW = new Date("2026-11-20T15:00:00Z");
const TZ = "America/Lima";
const context: ContextLine[] = [
  { at: "2026-11-19 10:00", fromOwner: true, text: "Jose, te recuerdo el pago del 3" },
  { at: "2026-11-19 11:30", fromOwner: false, text: "Ok, lo reviso" },
];

async function run(llm: FakeLlm, instruction = "Remind Jose about the payment") {
  return composeScheduled(
    { llm, readContext: async () => context },
    { chatId: "5199@c.us", instruction, now: NOW, timezone: TZ },
  );
}

describe("composeScheduled", () => {
  it("sends when the tool says send", async () => {
    const llm = new FakeLlm(
      result(decide({ action: "send", text: "Hola **Jose**, ¿cómo vas?", reason: "due" })),
    );
    const { decision } = await run(llm);
    expect(decision).toEqual({ action: "send", text: "Hola *Jose*, ¿cómo vas?", reason: "due" });
  });

  it("skips when the tool says skip", async () => {
    const llm = new FakeLlm(result(decide({ action: "skip", reason: "ya pagó el 3" })));
    const { decision } = await run(llm);
    expect(decision).toEqual({ action: "skip", reason: "ya pagó el 3" });
  });

  it("no tool call means skip", async () => {
    const llm = new FakeLlm(
      result(block({ type: "text", text: "Sure, here you go", citations: null })),
    );
    const { decision } = await run(llm);
    expect(decision).toEqual({ action: "skip", reason: "no decision" });
  });

  it("malformed input means skip", async () => {
    const llm = new FakeLlm(result(decide({ action: "send", reason: "x" })));
    const { decision } = await run(llm);
    expect(decision).toEqual({ action: "skip", reason: "no decision" });
  });

  it("an over-long text means skip instead of throwing", async () => {
    const llm = new FakeLlm(
      result(decide({ action: "send", text: "a".repeat(MAX_TEXT_CHARS + 1), reason: "x" })),
    );
    const { decision } = await run(llm);
    expect(decision).toEqual({ action: "skip", reason: "no decision" });
  });

  it("prompt carries instruction, local date and context", async () => {
    const llm = new FakeLlm(result(decide({ action: "skip", reason: "x" })));
    await run(llm, "Remind Jose about the payment");
    const req = llm.requests[0];
    const prompt = `${req.system}\n${JSON.stringify(req.messages)}`;
    expect(prompt).toContain("Remind Jose about the payment");
    expect(prompt).toContain(formatLocal(NOW, TZ));
    expect(prompt).toContain("Owner: Jose, te recuerdo el pago del 3");
    expect(prompt).toContain("Contact: Ok, lo reviso");
    expect(req.tools.map((t) => t.name)).toEqual(["decide"]);
    expect(req.effort).toBe("low");
    expect(req.maxTokens).toBe(1000);
  });

  it("returns usage from the fake", async () => {
    const llm = new FakeLlm(result(decide({ action: "skip", reason: "x" })));
    expect((await run(llm)).usage).toEqual(usage);
  });
});
