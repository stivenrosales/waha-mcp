import { describe, expect, it, vi } from "vitest";
import type { MessageActions } from "../../../../src/application/messageActions.js";
import { loadConfig } from "../../../../src/config.js";
import { InvalidInputError } from "../../../../src/domain/errors.js";
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
const tool = createTools().find((t) => t.name === "edit_message") as ToolDefinition;
const ID = "true_51911111111@c.us_3EB048E8C5255D99A10418";

function harness() {
  const sender = new RecordingSender();
  const applyEdit = vi.fn(async (..._a: unknown[]) => {});
  const ownerSent = vi.fn(async () => {});
  const deps = {
    mapper: async () => gowsMapper,
    config,
    sender,
    messageActions: { applyEdit } as unknown as MessageActions,
    missions: { ownerSent },
  } as unknown as ToolDeps;
  const call = async (input: Record<string, unknown>) => {
    const r = await createToolHandler(tool, deps)(tool.inputSchema.parse(input));
    return { isError: r.isError === true, text: (r.content[0] as { text: string }).text };
  };
  return { sender, applyEdit, ownerSent, call };
}

describe("edit_message", () => {
  it("edits own message with WhatsApp formatting", async () => {
    const h = harness();
    const r = await h.call({ message_id: ID, text: "**hola**" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("*hola*");
    expect(h.sender.calls).toEqual([
      {
        method: "editMessage",
        args: { chatId: "51911111111@c.us", messageId: ID, text: "*hola*" },
      },
    ]);
  });

  it("refuses someone else's message", async () => {
    const h = harness();
    const r = await h.call({ message_id: ID.replace("true_", "false_"), text: "x" });
    expect(r).toEqual({
      isError: true,
      text: "You can only edit your own messages (ids that start with true_).",
    });
    expect(h.sender.calls).toEqual([]);
  });

  it("updates the cache right away", async () => {
    const h = harness();
    await h.call({ message_id: ID, text: "nuevo" });
    expect(h.applyEdit).toHaveBeenCalledWith("3EB048E8C5255D99A10418", "nuevo", expect.any(Number));
  });

  it("still succeeds when the local copy cannot be updated", async () => {
    const h = harness();
    h.applyEdit.mockRejectedValueOnce(new Error("db down"));
    const r = await h.call({ message_id: ID, text: "nuevo" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("The local copy will update on the next sync.");
  });

  it("explains a too-late edit", async () => {
    const h = harness();
    h.sender.failMethods.editMessage = new InvalidInputError("WAHA rejected the message: old.");
    const r = await h.call({ message_id: ID, text: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "WAHA rejected the message: old. WhatsApp only allows editing recent messages.",
    );
    expect(h.applyEdit).not.toHaveBeenCalled();
  });

  it("does not take over a mission", async () => {
    const h = harness();
    await h.call({ message_id: ID, text: "x" });
    expect(h.ownerSent).not.toHaveBeenCalled();
  });

  it("rejects an over-long text and a bad id without calling WAHA", async () => {
    const h = harness();
    expect((await h.call({ message_id: ID, text: "a".repeat(70000) })).isError).toBe(true);
    expect((await h.call({ message_id: "3EB0", text: "x" })).isError).toBe(true);
    expect(h.sender.calls).toEqual([]);
  });
});
