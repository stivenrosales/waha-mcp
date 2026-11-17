import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTenantAdmin } from "../../../../../src/application/tenantAdmin.js";
import { createAuthStore, openAuthDatabase } from "../../../../../src/infrastructure/auth/store.js";
import { generateDek, wrapDek } from "../../../../../src/infrastructure/crypto/envelope.js";
import type {
  ToolDefinition,
  ToolRunContext,
} from "../../../../../src/infrastructure/mcp/defineTool.js";
import { getLlmUsageTool } from "../../../../../src/infrastructure/mcp/tools/admin/getLlmUsage.js";
import { createAdminTools } from "../../../../../src/infrastructure/mcp/tools/admin/index.js";
import { createSqliteMissionStore } from "../../../../../src/infrastructure/missions/sqliteMissionStore.js";
import { createSqliteTenantStore } from "../../../../../src/infrastructure/tenants/sqliteTenantStore.js";
import { FakeSessionAdmin } from "../../../../fakes/FakeSessionAdmin.js";

describe("get_llm_usage", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function world() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-llmusage-"));
    scratch.push(dataDir);
    const db = openAuthDatabase(":memory:");
    const store = createSqliteTenantStore(db);
    const admin = createTenantAdmin({
      tenants: store,
      auth: createAuthStore(db),
      missions: createSqliteMissionStore(db),
      sessions: new FakeSessionAdmin(),
      registry: { evict: () => {} },
      newWrappedDek: (id) => wrapDek(Buffer.alloc(32, 1), generateDek(), id),
      dataDir,
      publicBaseUrl: "https://mcp.example.com",
      logger: { info: () => {} },
      timezone: "UTC",
      now: () => Date.parse("2027-01-15T08:00:00.000Z"),
    });
    const owner = store.createTenant({ displayName: "Owner", wahaSession: "t_o", wrappedDek: "x" });
    const ctx = { admin } as unknown as ToolRunContext;
    const tool = getLlmUsageTool as unknown as ToolDefinition;
    const run = (input: unknown) =>
      tool.run(tool.inputSchema.parse(input), ctx) as Promise<{
        text: string;
        data: Record<string, unknown>;
      }>;
    const record = (tenantId: string, at: string, costUsd: number | null, missionId = "m1") =>
      store.recordLlmUsage({
        tenantId,
        missionId,
        at,
        model: "anthropic/claude-haiku-5.5",
        kind: "agent",
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 500,
          cacheWriteTokens: 0,
          costUsd,
        },
      });
    return { run, store, owner, record };
  }

  it("is registered as a read-only admin tool", () => {
    const tool = createAdminTools().find((t) => t.name === "get_llm_usage");
    expect(tool).toBeDefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("refuses without the admin service", async () => {
    const tool = getLlmUsageTool as unknown as ToolDefinition;
    await expect(tool.run(tool.inputSchema.parse({}), {} as ToolRunContext)).rejects.toThrow(
      "Admin tools are not available on this server.",
    );
  });

  it("says No mission LLM usage for an empty range", async () => {
    const { run } = await world();
    const res = await run({ from: "2026-12-01", to: "2026-12-31" });
    expect(res.text).toBe(
      "No mission LLM usage between 2026-12-01T00:00:00.000Z and 2026-12-31T23:59:59.999Z.",
    );
    expect(res.data).toMatchObject({ tenants: [], total: { calls: 0, costUsd: 0 } });
  });

  it("lists each tenant most expensive first, the total and calls without cost (current month by default)", async () => {
    const { run, store, owner, record } = await world();
    const gone = store.createTenant({ displayName: "Gone", wahaSession: "t_g", wrappedDek: "x" });
    record(owner.id, "2027-01-10T00:00:00.000Z", 0.01, "m1");
    record(owner.id, "2027-01-11T00:00:00.000Z", null, "m2");
    record(gone.id, "2027-01-12T00:00:00.000Z", 0.05, "m3");
    record(owner.id, "2026-12-31T23:59:59.999Z", 9, "m0");
    store.deleteTenant(gone.id);
    const res = await run({});
    expect(res.text).toBe(
      [
        "Mission LLM usage 2027-01-01T00:00:00.000Z → 2027-01-15T08:00:00.000Z:",
        `- (deleted tenant) (${gone.id}) · 1 call · 1 mission · 1000 in / 200 out / 500 cached tokens · $0.0500`,
        `- Owner (${owner.id}) · 2 calls · 2 missions · 2000 in / 400 out / 1000 cached tokens · $0.0100`,
        "Total: 3 calls · 3 missions · 3000 in / 600 out / 1500 cached tokens · $0.0600",
        "1 call(s) without cost reported: the total does not include them.",
      ].join("\n"),
    );
    expect(res.data).toMatchObject({
      from: "2027-01-01T00:00:00.000Z",
      to: "2027-01-15T08:00:00.000Z",
      total: { calls: 3, missions: 3, rowsWithoutCost: 1 },
    });
  });

  it("filters one tenant", async () => {
    const { run, store, owner, record } = await world();
    const other = store.createTenant({ displayName: "Other", wahaSession: "t_x", wrappedDek: "x" });
    record(owner.id, "2027-01-10T00:00:00.000Z", 0.01);
    record(other.id, "2027-01-10T00:00:00.000Z", 0.02);
    const res = await run({ tenant_id: owner.id });
    expect((res.data.tenants as { id: string }[]).map((t) => t.id)).toEqual([owner.id]);
  });

  it("a to-only range starts at the month holding to", async () => {
    const { run } = await world();
    const res = await run({ to: "2026-10-15" });
    expect(res.data).toMatchObject({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-15T23:59:59.999Z",
    });
  });
});
