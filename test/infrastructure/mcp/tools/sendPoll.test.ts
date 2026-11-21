import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../../src/config.js";
import {
  createToolHandler,
  type ToolDefinition,
  type ToolDeps,
} from "../../../../src/infrastructure/mcp/defineTool.js";
import { createTools } from "../../../../src/infrastructure/mcp/tools/index.js";
import { gowsMapper } from "../../../../src/infrastructure/waha/engines/gows.js";
import { RecordingSender } from "../../../fakes/InMemoryWahaGateway.js";

const config = loadConfig({
  WAHA_API_URL: "http://waha:3000",
  WAHA_API_KEY: "k",
  PUBLIC_BASE_URL: "https://mcp.example.com",
  MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "correct horse battery",
});
const tool = createTools().find((t) => t.name === "send_poll") as ToolDefinition;

function harness() {
  const sender = new RecordingSender();
  const ownerSent = vi.fn(async () => {});
  const deps = {
    mapper: async () => gowsMapper,
    config,
    sender,
    missions: { ownerSent },
  } as unknown as ToolDeps;
  const call = async (input: Record<string, unknown>) => {
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) return { isError: true, text: parsed.error.message };
    const r = await createToolHandler(tool, deps)(parsed.data);
    return {
      isError: r.isError === true,
      text: (r.content[0] as { text: string }).text,
      data: r.structuredContent as Record<string, unknown> | undefined,
    };
  };
  return { sender, ownerSent, call };
}

describe("send_poll", () => {
  it("is a send tool listed before react_message", () => {
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(tool.description).toContain("Send only when the owner explicitly asked");
    const names = createTools().map((t) => t.name);
    expect(names.indexOf("send_poll")).toBe(names.indexOf("send_contact") + 1);
    expect(names.indexOf("react_message")).toBe(names.indexOf("send_poll") + 1);
  });

  it("sends and returns the poll id", async () => {
    const h = harness();
    const r = await h.call({
      chat_id: "1@g.us",
      question: "¿Cuándo?",
      options: ["Lunes", " Martes "],
      reply_to: "r1",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      "Sent poll to 1@g.us (message true_sent_1). Read votes with get_poll_results.",
    );
    expect(r.data).toMatchObject({ chat_id: "1@g.us", message_id: "true_sent_1" });
    expect(h.sender.calls).toEqual([
      {
        method: "sendPoll",
        args: {
          chatId: "1@g.us",
          replyTo: "r1",
          question: "¿Cuándo?",
          options: ["Lunes", "Martes"],
          multipleAnswers: false,
        },
      },
    ]);
  });

  it("rejects 1 option and 13 options", async () => {
    const h = harness();
    expect((await h.call({ chat_id: "1@c.us", question: "q", options: ["a"] })).isError).toBe(true);
    const many = Array.from({ length: 13 }, (_, i) => `o${i}`);
    expect((await h.call({ chat_id: "1@c.us", question: "q", options: many })).isError).toBe(true);
    const twelve = Array.from({ length: 12 }, (_, i) => `o${i}`);
    expect((await h.call({ chat_id: "1@c.us", question: "q", options: twelve })).isError).toBe(
      false,
    );
  });

  it('rejects duplicate options ("Sí" and " sí ")', async () => {
    const h = harness();
    const r = await h.call({ chat_id: "1@c.us", question: "q", options: ["Sí", " sí ", "No"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Poll options must be different from each other.");
    expect(h.sender.calls).toEqual([]);
  });

  it("rejects a 101-character option and a 256-character question", async () => {
    const h = harness();
    expect(
      (await h.call({ chat_id: "1@c.us", question: "q", options: ["a", "x".repeat(101)] })).isError,
    ).toBe(true);
    expect(
      (await h.call({ chat_id: "1@c.us", question: "q".repeat(256), options: ["a", "b"] })).isError,
    ).toBe(true);
    expect(
      (
        await h.call({
          chat_id: "1@c.us",
          question: "q".repeat(255),
          options: ["a", "x".repeat(100)],
        })
      ).isError,
    ).toBe(false);
  });

  it("passes multiple_answers through", async () => {
    const h = harness();
    await h.call({ chat_id: "1@c.us", question: "q", options: ["a", "b"], multiple_answers: true });
    expect(h.sender.calls[0]?.args).toMatchObject({ multipleAnswers: true });
  });

  it("takes over an active mission", async () => {
    const h = harness();
    await h.call({ chat_id: "1@c.us", question: "q", options: ["a", "b"] });
    expect(h.ownerSent).toHaveBeenCalledWith("1@c.us");
  });
});
