import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTenantAdmin } from "../../../src/application/tenantAdmin.js";
import { createAuthStore, openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { generateDek, wrapDek } from "../../../src/infrastructure/crypto/envelope.js";
import {
  createToolHandler,
  type ToolDefinition,
  type ToolDeps,
  type ToolRunContext,
} from "../../../src/infrastructure/mcp/defineTool.js";
import { createAdminTools } from "../../../src/infrastructure/mcp/tools/admin/index.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";
import { FakeSessionAdmin } from "../../fakes/FakeSessionAdmin.js";

const tools = createAdminTools();
const byName = (n: string) => tools.find((t) => t.name === n);

describe("admin tools", () => {
  it("exposes the eight tools with the right annotations", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "create_invite",
        "delete_tenant",
        "get_tool_usage",
        "get_transcription_usage",
        "list_tenants",
        "reset_password",
        "restore_tenant",
        "revoke_tenant",
      ].sort(),
    );
    expect(byName("delete_tenant")?.annotations?.destructiveHint).toBe(true);
    expect(byName("list_tenants")?.annotations?.readOnlyHint).toBe(true);
    expect(byName("get_transcription_usage")?.annotations?.readOnlyHint).toBe(true);
    expect(byName("get_tool_usage")?.annotations?.readOnlyHint).toBe(true);
    for (const n of ["create_invite", "reset_password", "revoke_tenant", "restore_tenant"]) {
      expect(byName(n)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it("fails with a clear error when the server has no admin service", async () => {
    const tool = byName("list_tenants");
    const handler = createToolHandler(
      tool as never,
      {
        mapper: async () => ({}),
        config: { publicBaseUrl: "https://x.example" },
      } as unknown as ToolDeps,
    );
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: "Admin tools are not available on this server.",
    });
  });
});

describe("admin tool output through run()", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function world() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-admintools-"));
    scratch.push(dataDir);
    const db = openAuthDatabase(":memory:");
    const store = createSqliteTenantStore(db);
    const sessions = new FakeSessionAdmin();
    const admin = createTenantAdmin({
      tenants: store,
      auth: createAuthStore(db),
      sessions,
      registry: { evict: () => {} },
      newWrappedDek: (id) => wrapDek(Buffer.alloc(32, 1), generateDek(), id),
      dataDir,
      publicBaseUrl: "https://mcp.example.com",
      logger: { info: () => {} },
      timezone: "UTC",
      now: () => Date.parse("2027-01-15T08:00:00.000Z"),
    });
    const owner = store.createTenant({ displayName: "Owner", wahaSession: "t_o", wrappedDek: "x" });
    await store.createUser({
      tenantId: owner.id,
      username: "admin",
      password: "correct horse battery",
      role: "admin",
    });
    const ctx = { admin } as unknown as ToolRunContext;
    const run = (name: string, input: unknown) => {
      const tool = createAdminTools().find((t) => t.name === name) as ToolDefinition;
      return tool.run(tool.inputSchema.parse(input), ctx) as Promise<{
        text: string;
        data: Record<string, unknown>;
      }>;
    };
    return { run, store, sessions, owner };
  }

  it("create_invite, revoke_tenant, restore_tenant and delete_tenant report clean text and data", async () => {
    const { run } = await world();
    const invite = await run("create_invite", { display_name: "Acme" });
    const id = invite.data.tenantId as string;
    expect(invite.text).toBe(
      `Invite link for tenant ${id} (expires ${invite.data.expiresAt}, single use):\n${invite.data.url}`,
    );
    expect(invite.data.url).toMatch(/^https:\/\/mcp\.example\.com\/invite\//);

    const revoked = await run("revoke_tenant", { tenant_id: id });
    expect(revoked.text).toBe(`Tenant ${id} revoked.`);
    expect(revoked.data).toEqual({ tenantId: id, status: "revoked" });

    const restored = await run("restore_tenant", { tenant_id: id });
    expect(restored.text).toBe(`Tenant ${id} restored; status is now invited.`);
    expect(restored.data).toEqual({ tenantId: id, status: "invited" });

    const deleted = await run("delete_tenant", { tenant_id: id, confirm_display_name: "Acme" });
    expect(deleted.text).toBe(`Tenant ${id} deleted.`);
    expect(deleted.data).toEqual({
      tenantId: id,
      deleted: true,
      whatsappCleanup: "ok",
      localCleanup: "ok",
    });
  });

  it("delete_tenant names the WAHA session when cleanup fails", async () => {
    const { run, store, sessions } = await world();
    const invite = await run("create_invite", { display_name: "Acme" });
    const id = invite.data.tenantId as string;
    const session = store.getTenant(id)?.wahaSession as string;
    sessions.remove = async () => {
      throw new Error("waha down");
    };
    const deleted = await run("delete_tenant", { tenant_id: id, confirm_display_name: "Acme" });
    expect(deleted.text).toBe(
      `Tenant ${id} deleted. The WhatsApp session ${session} could not be removed from WAHA; log it out and delete it there manually.`,
    );
    expect(deleted.data).toEqual({
      tenantId: id,
      deleted: true,
      whatsappCleanup: "failed",
      localCleanup: "ok",
      wahaSession: session,
    });
  });

  it("keeps the full revoke description", () => {
    expect(byName("revoke_tenant")?.description).toBe(
      "Revokes a tenant's access: its sessions and tokens stop working immediately and its data is kept. Reversible with restore_tenant. The admin tenant cannot be revoked.",
    );
  });

  it("get_transcription_usage lists each tenant, the total and missing costs", async () => {
    const { run, store, owner } = await world();
    store.recordTranscriptionUsage({
      tenantId: owner.id,
      at: "2027-01-10T00:00:00.000Z",
      model: "m",
      seconds: 12,
      costUsd: 0.03,
    });
    store.recordTranscriptionUsage({
      tenantId: owner.id,
      at: "2027-01-11T00:00:00.000Z",
      model: "m",
      seconds: 3,
      costUsd: null,
    });
    const res = await run("get_transcription_usage", {});
    expect(res.text).toBe(
      [
        "Transcription usage 2027-01-01T00:00:00.000Z → 2027-01-15T08:00:00.000Z:",
        `- Owner (${owner.id}) · 2 transcriptions · 15 s · $0.0300`,
        "Total: 2 transcriptions · 15 s · $0.0300",
        "1 transcription(s) without cost reported: the total does not include them.",
      ].join("\n"),
    );
    expect(res.data).toMatchObject({ total: { count: 2, seconds: 15, rowsWithoutCost: 1 } });
  });

  it("get_transcription_usage says when the range is empty", async () => {
    const { run } = await world();
    const res = await run("get_transcription_usage", { from: "2026-12-01", to: "2026-12-31" });
    expect(res.text).toBe(
      "No transcriptions between 2026-12-01T00:00:00.000Z and 2026-12-31T23:59:59.999Z.",
    );
  });

  it("get_transcription_usage is an admin tool and refuses without the admin service", async () => {
    const tool = createAdminTools().find(
      (t) => t.name === "get_transcription_usage",
    ) as ToolDefinition;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    await expect(tool.run(tool.inputSchema.parse({}), {} as ToolRunContext)).rejects.toThrow(
      "Admin tools are not available on this server.",
    );
  });

  it("get_tool_usage lists each tenant with its tools, and the total", async () => {
    const { run, store, owner } = await world();
    const rec = (at: string, tool: string, outcome = "ok") =>
      store.recordToolCall({ tenantId: owner.id, at, tool, outcome, ms: 3 });
    rec("2027-01-10T00:00:00.000Z", "list_chats");
    rec("2027-01-11T00:00:00.000Z", "list_chats");
    rec("2027-01-12T00:00:00.000Z", "send_text", "Boom");
    const res = await run("get_tool_usage", {});
    expect(res.text).toBe(
      [
        "Tool usage 2027-01-01T00:00:00.000Z → 2027-01-15T08:00:00.000Z:",
        `- Owner (${owner.id}) · 3 calls · 1 error · last 2027-01-12T00:00:00.000Z`,
        "  list_chats 2 · send_text 1 (1 error)",
        "Total: 3 calls · 1 error",
      ].join("\n"),
    );
    expect(res.data).toMatchObject({ total: { calls: 3, errors: 1 } });
  });

  it("get_tool_usage says when the range is empty", async () => {
    const { run } = await world();
    const res = await run("get_tool_usage", { from: "2026-12-01", to: "2026-12-31" });
    expect(res.text).toBe(
      "No tool calls between 2026-12-01T00:00:00.000Z and 2026-12-31T23:59:59.999Z.",
    );
  });
});
