import { describe, expect, it, vi } from "vitest";
import type { MessageActions } from "../../../../src/application/messageActions.js";
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
const tool = createTools().find((t) => t.name === "react_message") as ToolDefinition;
const ID = "true_51911111111@c.us_3EB048E8C5255D99A10418";

function harness() {
  const sender = new RecordingSender();
  const applyReaction = vi.fn(async () => {});
  const ownerSent = vi.fn(async () => {});
  const deps = {
    mapper: async () => gowsMapper,
    config,
    sender,
    messageActions: { applyReaction } as unknown as MessageActions,
    missions: { ownerSent },
  } as unknown as ToolDeps;
  const call = async (input: Record<string, unknown>) => {
    const r = await createToolHandler(tool, deps)(tool.inputSchema.parse(input));
    return { isError: r.isError === true, text: (r.content[0] as { text: string }).text };
  };
  return { sender, applyReaction, ownerSent, call };
}

describe("react_message", () => {
  it("is a send tool listed after send_contact", () => {
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    const names = createTools().map((t) => t.name);
    expect(names.indexOf("react_message")).toBe(names.indexOf("send_contact") + 1);
  });

  it("reacts and stores the own reaction", async () => {
    const h = harness();
    const r = await h.call({ message_id: ID, emoji: "👍" });
    expect(r).toEqual({ isError: false, text: `Reacted 👍 to message ${ID}.` });
    expect(h.sender.calls).toEqual([{ method: "react", args: { messageId: ID, emoji: "👍" } }]);
    expect(h.applyReaction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "3EB048E8C5255D99A10418", reactor: "me", emoji: "👍" }),
    );
  });

  it('"" removes the reaction', async () => {
    const h = harness();
    const r = await h.call({ message_id: ID, emoji: "" });
    expect(r.text).toBe(`Removed your reaction from message ${ID}.`);
    expect(h.sender.calls[0]?.args).toEqual({ messageId: ID, emoji: "" });
    expect(h.applyReaction).toHaveBeenCalledWith(
      expect.objectContaining({ reactor: "me", emoji: "" }),
    );
  });

  it("rejects a bad id and a bad emoji without calling WAHA", async () => {
    const h = harness();
    const bad = await h.call({ message_id: "3EB0", emoji: "👍" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('"message_id" must be a full message id');
    const emoji = await h.call({ message_id: ID, emoji: "ok" });
    expect(emoji).toEqual({
      isError: true,
      text: '"emoji" must be one emoji, or "" to remove your reaction.',
    });
    expect(h.sender.calls).toEqual([]);
    expect(h.applyReaction).not.toHaveBeenCalled();
  });

  it("does not take over a mission", async () => {
    const h = harness();
    await h.call({ message_id: ID, emoji: "❤️" });
    expect(h.ownerSent).not.toHaveBeenCalled();
  });

  it("does not store anything when WAHA fails", async () => {
    const h = harness();
    h.sender.failMethods.react = new Error("boom");
    expect((await h.call({ message_id: ID, emoji: "👍" })).isError).toBe(true);
    expect(h.applyReaction).not.toHaveBeenCalled();
  });
});
