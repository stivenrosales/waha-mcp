import { describe, expect, it } from "vitest";
import { createToolHandler, type ToolDeps } from "../../../src/infrastructure/mcp/defineTool.js";
import { createAdminTools } from "../../../src/infrastructure/mcp/tools/admin/index.js";

describe("admin tools", () => {
  const tools = createAdminTools();
  const byName = (n: string) => tools.find((t) => t.name === n);

  it("exposes the six tools with the right annotations", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "create_invite",
        "delete_tenant",
        "list_tenants",
        "reset_password",
        "restore_tenant",
        "revoke_tenant",
      ].sort(),
    );
    expect(byName("delete_tenant")?.annotations?.destructiveHint).toBe(true);
    expect(byName("list_tenants")?.annotations?.readOnlyHint).toBe(true);
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
