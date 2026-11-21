import { describe, expect, it, vi } from "vitest";
import type { MessageActions } from "../../../../src/application/messageActions.js";
import { loadConfig } from "../../../../src/config.js";
import { InvalidInputError } from "../../../../src/domain/errors.js";
import {
  createToolHandler,
  DESTRUCTIVE_ANNOTATIONS,
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
const tool = createTools().find((t) => t.name === "delete_message") as ToolDefinition;
const ID = "true_51911111111@c.us_3EB048E8C5255D99A10418";

function harness() {
  const sender = new RecordingSender();
  const applyRevoke = vi.fn(async (..._a: unknown[]) => {});
  const ownerSent = vi.fn(async () => {});
  const logs: string[] = [];
  const deps = {
    mapper: async () => gowsMapper,
    config,
    sender,
    messageActions: { applyRevoke } as unknown as MessageActions,
    missions: { ownerSent },
    logger: { info: (m: string) => logs.push(m) },
  } as unknown as ToolDeps;
  const call = async (input: Record<string, unknown>) => {
    const r = await createToolHandler(tool, deps)(tool.inputSchema.parse(input));
    return { isError: r.isError === true, text: (r.content[0] as { text: string }).text };
  };
  return { sender, applyRevoke, ownerSent, logs, call };
}

describe("delete_message", () => {
  it("deletes own message and blanks the cache", async () => {
    const h = harness();
    const r = await h.call({ message_id: ID });
    expect(r.isError).toBe(false);
    expect(tool.annotations).toEqual(DESTRUCTIVE_ANNOTATIONS);
    expect(h.sender.calls).toEqual([
      { method: "deleteMessage", args: { chatId: "51911111111@c.us", messageId: ID } },
    ]);
    expect(h.applyRevoke).toHaveBeenCalledWith("3EB048E8C5255D99A10418", expect.any(Number));
  });

  it("result says it cannot be undone", async () => {
    const h = harness();
    const r = await h.call({ message_id: ID });
    expect(r.text).toBe(`Deleted message ${ID} for everyone. This cannot be undone.`);
  });

  it("refuses someone else's message", async () => {
    const h = harness();
    const r = await h.call({ message_id: ID.replace("true_", "false_") });
    expect(r).toEqual({
      isError: true,
      text: "You can only delete your own messages (ids that start with true_).",
    });
    expect(h.sender.calls).toEqual([]);
    expect(h.applyRevoke).not.toHaveBeenCalled();
  });

  it("still succeeds when the local copy cannot be updated", async () => {
    const h = harness();
    h.applyRevoke.mockRejectedValueOnce(new Error("db down"));
    const r = await h.call({ message_id: ID });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("The local copy will update on the next sync.");
    expect(h.logs).toContain("message-action kind=delete outcome=local-apply-failed error=Error");
  });

  it("explains a too-late delete", async () => {
    const h = harness();
    h.sender.failMethods.deleteMessage = new InvalidInputError("WAHA rejected the message.");
    const r = await h.call({ message_id: ID });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "WAHA rejected the message. WhatsApp only allows deleting for everyone within a limited time.",
    );
    expect(h.applyRevoke).not.toHaveBeenCalled();
  });

  it("does not take over a mission", async () => {
    const h = harness();
    await h.call({ message_id: ID });
    expect(h.ownerSent).not.toHaveBeenCalled();
  });

  it("rejects a bad id without calling WAHA", async () => {
    const h = harness();
    expect((await h.call({ message_id: "3EB0" })).isError).toBe(true);
    expect(h.sender.calls).toEqual([]);
  });
});
