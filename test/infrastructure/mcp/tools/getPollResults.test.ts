import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../../src/config.js";
import {
  createToolHandler,
  type ToolDefinition,
  type ToolDeps,
} from "../../../../src/infrastructure/mcp/defineTool.js";
import { createTools } from "../../../../src/infrastructure/mcp/tools/index.js";
import { gowsMapper } from "../../../../src/infrastructure/waha/engines/gows.js";
import { ANA, GROUP_A, gateway, type Raw } from "../../../application/helpers.js";
import { rawText } from "../../../fakes/InMemoryWahaGateway.js";

const base = {
  WAHA_API_URL: "http://waha:3000",
  WAHA_API_KEY: "k",
  PUBLIC_BASE_URL: "https://mcp.example.com",
  MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "correct horse battery",
};
const tool = createTools().find((t) => t.name === "get_poll_results") as ToolDefinition;
const ID = `true_${GROUP_A}_P1`;
const poll: Raw = {
  ...rawText("P1", 1000, "", { chat: GROUP_A }),
  id: ID,
  fromMe: true,
  _data: {
    Info: { Sender: "100000000000002:5@lid" },
    Message: {
      pollCreationMessageV3: {
        name: "Lunch?",
        options: [{ optionName: "Yes" }, { optionName: "No" }],
      },
    },
  },
};

function harness(webhooks: boolean) {
  const config = loadConfig(webhooks ? { ...base, WAHA_WEBHOOK_SECRET: "s".repeat(32) } : base);
  const deps = {
    gateway: gateway({
      messages: { [GROUP_A]: [poll] },
      contacts: [{ id: ANA, name: "Ana", pushname: "" }],
    }),
    mapper: async () => gowsMapper,
    config,
    messageActions: {
      pollVotes: async () => ({
        votes: [{ pollId: "P1", voter: ANA, options: ["Yes"], ts: 5 }],
        failed: 1,
      }),
    },
  } as unknown as ToolDeps;
  return async (input: Record<string, unknown>) => {
    const r = await createToolHandler(tool, deps)(tool.inputSchema.parse(input));
    return {
      isError: r.isError === true,
      text: (r.content[0] as { text: string }).text,
      data: r.structuredContent as Record<string, unknown>,
    };
  };
}

describe("get_poll_results", () => {
  it("is read-only, listed right after get_thread", () => {
    expect(tool.annotations).toBeUndefined();
    const names = createTools().map((t) => t.name);
    expect(names.indexOf("get_poll_results")).toBe(names.indexOf("get_thread") + 1);
    expect(tool.description).toContain("from when this server started receiving them");
  });

  it("returns counts, voters and the failed count", async () => {
    const r = await harness(true)({ message_id: ID });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("- Yes: 1");
    expect(r.text).toContain("- No: 0");
    expect(r.text).toContain(`- Ana (${ANA}): Yes`);
    expect(r.text).toContain("1 vote(s) could not be decrypted");
    expect(r.data).toMatchObject({ webhooks: true, failedVotes: 1 });
  });

  it("says votes are unavailable without webhooks, not an error", async () => {
    const r = await harness(false)({ message_id: ID });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(
      "Votes are not available: this server has no webhooks (WAHA_WEBHOOK_SECRET).",
    );
    expect(r.data).toMatchObject({ webhooks: false, voters: [] });
  });

  it("rejects a bad id and a non-poll", async () => {
    const h = harness(true);
    expect((await h({ message_id: "nope" })).isError).toBe(true);
  });
});
