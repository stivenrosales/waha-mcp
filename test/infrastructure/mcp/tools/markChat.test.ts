import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../../src/config.js";
import { WahaNotFoundError } from "../../../../src/domain/errors.js";
import {
  createToolHandler,
  IDEMPOTENT_WRITE_ANNOTATIONS,
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
const CHAT = "51911111111@c.us";

function harness(name: string) {
  const tool = createTools().find((t) => t.name === name) as ToolDefinition;
  const sender = new RecordingSender();
  const ownerSent = vi.fn(async () => {});
  const logs: string[] = [];
  const deps = {
    mapper: async () => gowsMapper,
    config,
    sender,
    missions: { ownerSent },
    logger: { info: (m: string) => logs.push(m) },
  } as unknown as ToolDeps;
  const call = async (input: Record<string, unknown>) => {
    const r = await createToolHandler(tool, deps)(tool.inputSchema.parse(input));
    return { isError: r.isError === true, text: (r.content[0] as { text: string }).text };
  };
  return { tool, sender, ownerSent, logs, call };
}

describe.each([
  ["mark_read", "markRead", "read"],
  ["mark_unread", "markUnread", "unread"],
])("%s", (name, method, word) => {
  it("marks the chat through the sender", async () => {
    const h = harness(name);
    const r = await h.call({ chat_id: CHAT });
    expect(r).toEqual({ isError: false, text: `Marked ${CHAT} as ${word}.` });
    expect(h.sender.calls).toEqual([{ method, args: CHAT }]);
    expect(h.tool.annotations).toEqual(IDEMPOTENT_WRITE_ANNOTATIONS);
  });

  it("does not take over a mission", async () => {
    const h = harness(name);
    await h.call({ chat_id: CHAT });
    expect(h.ownerSent).not.toHaveBeenCalled();
  });

  it("reports a missing chat", async () => {
    const h = harness(name);
    h.sender.failMethods[method] = new WahaNotFoundError("chat");
    expect(await h.call({ chat_id: CHAT })).toEqual({
      isError: true,
      text: "Chat or message not found.",
    });
  });

  it("rejects an empty chat id", () => {
    expect(() => harness(name).tool.inputSchema.parse({ chat_id: "" })).toThrow();
  });
});
