import { describe, expect, it } from "vitest";
import type { SelfService } from "../../../../src/application/selfService.js";
import { InvalidInputError } from "../../../../src/domain/errors.js";
import type {
  ToolDefinition,
  ToolRunContext,
} from "../../../../src/infrastructure/mcp/defineTool.js";
import { createTools } from "../../../../src/infrastructure/mcp/tools/index.js";
import {
  deleteMyDataTool,
  unlinkAccountTool,
} from "../../../../src/infrastructure/mcp/tools/selfService.js";

function harness(self: Partial<SelfService> | null) {
  const calls: string[] = [];
  const ctx = {
    config: { publicBaseUrl: "https://mcp.example.com/" },
    self: self && {
      deleteMyData: async () => {
        calls.push("delete");
        return (
          (await self.deleteMyData?.()) ?? {
            messages: 0,
            transcripts: 0,
            missions: 0,
            schedules: 0,
          }
        );
      },
      unlink: async () => {
        calls.push("unlink");
        return (await self.unlink?.()) ?? { whatsapp: "logged_out" as const, signedOut: true };
      },
    },
  } as unknown as ToolRunContext;
  const run = (def: unknown, input: unknown) => {
    const tool = def as ToolDefinition;
    return tool.run(tool.inputSchema.parse(input), ctx) as Promise<{
      text: string;
      data: Record<string, unknown>;
    }>;
  };
  return { calls, run };
}

describe("self-service tools", () => {
  it("both are listed for every tenant and marked destructive", () => {
    const names = createTools().map((t) => t.name);
    expect(names).toContain("delete_my_data");
    expect(names).toContain("unlink_account");
    for (const t of [deleteMyDataTool, unlinkAccountTool])
      expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("delete_my_data needs confirm: true; anything else is rejected before running", () => {
    for (const input of [{}, { confirm: false }, { confirm: "true" }])
      expect(deleteMyDataTool.inputSchema.safeParse(input).success).toBe(false);
    expect(deleteMyDataTool.inputSchema.safeParse({ confirm: true }).success).toBe(true);
  });

  it("delete_my_data deletes the caller's data and reports what was removed", async () => {
    const h = harness({
      deleteMyData: async () => ({ messages: 12, transcripts: 2, missions: 1, schedules: 3 }),
    });
    const out = await h.run(deleteMyDataTool, { confirm: true });
    expect(h.calls).toEqual(["delete"]);
    expect(out.data).toEqual({ messages: 12, transcripts: 2, missions: 1, schedules: 3 });
    expect(out.text).toBe(
      "Deleted this account's stored data: 12 cached messages, 2 transcripts, 1 ended missions and 3 ended scheduled messages (with their edits, reactions, poll votes and run history). Active missions and scheduled messages keep running. Messages are read from WhatsApp again when asked for.",
    );
  });

  it("unlink_account needs confirm: true", () => {
    for (const input of [{}, { confirm: false }])
      expect(unlinkAccountTool.inputSchema.safeParse(input).success).toBe(false);
    expect(unlinkAccountTool.inputSchema.safeParse({ confirm: true }).success).toBe(true);
  });

  it("unlink_account unlinks the caller and says how to come back", async () => {
    const h = harness({ unlink: async () => ({ whatsapp: "logged_out", signedOut: true }) });
    const out = await h.run(unlinkAccountTool, { confirm: true });
    expect(h.calls).toEqual(["unlink"]);
    expect(out.data).toEqual({ whatsapp: "logged_out", signedOut: true });
    expect(out.text).toBe(
      "WhatsApp is unlinked from this server and every connected app is signed out, this one included. To use it again, sign in at https://mcp.example.com/pair and scan the QR code.",
    );
  });

  it("unlink_account tells when WhatsApp could not be logged out", async () => {
    const h = harness({ unlink: async () => ({ whatsapp: "failed", signedOut: true }) });
    const out = await h.run(unlinkAccountTool, { confirm: true });
    expect(out.data).toEqual({ whatsapp: "failed", signedOut: true });
    expect(out.text).toContain(
      "WhatsApp could not be logged out right now: remove this server under Linked devices on your phone.",
    );
  });

  it("without a self service both refuse with a clear message", async () => {
    const h = harness(null);
    await expect(h.run(deleteMyDataTool, { confirm: true })).rejects.toThrow(InvalidInputError);
    await expect(h.run(unlinkAccountTool, { confirm: true })).rejects.toThrow(
      "Self-service is not available on this server.",
    );
  });
});
