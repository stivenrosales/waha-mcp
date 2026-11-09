import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../../src/config.js";
import { WhatsAppDisconnectedError } from "../../../src/domain/errors.js";
import {
  createToolHandler,
  type ToolDefinition,
  type ToolDeps,
} from "../../../src/infrastructure/mcp/defineTool.js";
import { gowsMapper } from "../../../src/infrastructure/waha/engines/gows.js";

const API_KEY = "k-very-secret";

const config = loadConfig({
  WAHA_API_URL: "http://waha:3000",
  WAHA_API_KEY: API_KEY,
  PUBLIC_BASE_URL: "https://mcp.example.com",
  MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "correct horse battery",
});

describe("createToolHandler", () => {
  it("maps WhatsAppDisconnectedError to the re-pair message, without the API key", async () => {
    const def: ToolDefinition = {
      name: "boom",
      title: "Boom",
      description: "Throws.",
      inputSchema: z.object({}),
      run: async () => {
        throw new WhatsAppDisconnectedError();
      },
    };
    const lines: string[] = [];
    const handler = createToolHandler(def, {
      mapper: async () => gowsMapper,
      config,
      logger: { info: (m: string) => lines.push(m) },
    } as unknown as ToolDeps);
    const result = await handler({});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe(
      "WhatsApp is disconnected for this account. Re-pair at https://mcp.example.com/pair.",
    );
    expect(text).toContain("/pair");
    expect(text).not.toContain(API_KEY);
    expect(lines.join("\n")).not.toContain(API_KEY);
    // A known error: no stack trace in the log.
    expect(lines.join("\n")).not.toContain("error stack");
  });

  it("reports every call's tool, outcome and duration, never its arguments", async () => {
    const calls: unknown[] = [];
    const deps = {
      mapper: async () => gowsMapper,
      config,
      onToolCall: (c: unknown) => calls.push(c),
    } as unknown as ToolDeps;
    const ok: ToolDefinition = {
      name: "fine",
      title: "Fine",
      description: "Works.",
      inputSchema: z.object({ secret: z.string() }),
      run: async () => ({ text: "done", data: {} }),
    };
    const bad: ToolDefinition = {
      ...ok,
      name: "broken",
      run: async () => {
        throw new WhatsAppDisconnectedError();
      },
    };
    await createToolHandler(ok, deps)({ secret: "hunter2" });
    await createToolHandler(bad, deps)({ secret: "hunter2" });
    expect(calls).toEqual([
      { tool: "fine", outcome: "ok", ms: expect.any(Number) },
      { tool: "broken", outcome: "WhatsAppDisconnectedError", ms: expect.any(Number) },
    ]);
    expect(JSON.stringify(calls)).not.toContain("hunter2");
  });

  it("answers the tool even when recording the call throws", async () => {
    const lines: string[] = [];
    const def: ToolDefinition = {
      name: "fine",
      title: "Fine",
      description: "Works.",
      inputSchema: z.object({}),
      run: async () => ({ text: "done", data: {} }),
    };
    const result = await createToolHandler(def, {
      mapper: async () => gowsMapper,
      config,
      logger: { info: (m: string) => lines.push(m) },
      onToolCall: () => {
        throw new Error("disk full");
      },
    } as unknown as ToolDeps)({});
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ text: "done" });
    expect(lines).toContain("tool=fine usage not recorded");
  });
});
