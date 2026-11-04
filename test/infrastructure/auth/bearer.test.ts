import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type AuthInfo, bearerGuard } from "../../../src/infrastructure/auth/bearer.js";
import { createAuthStore, openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";

const BASE = "https://mcp.example.com";

async function setup() {
  const db = openAuthDatabase(":memory:");
  const store = createAuthStore(db);
  const tenants = createSqliteTenantStore(db);
  const tenant = tenants.createTenant({
    displayName: "Ana",
    wahaSession: "t_abcdefghij",
    wrappedDek: "x",
  });
  tenants.setStatus(tenant.id, "active");
  const user = (await tenants.createUser({
    tenantId: tenant.id,
    username: "ana",
    password: "correct horse battery",
    role: "member",
  })) as { id: string };
  const { clientId } = store.registerClient({ redirectUris: ["https://claude.ai/cb"] });
  const { accessToken } = store.issueTokens(clientId, "mcp", user.id);
  const app = new Hono<{ Variables: { auth: AuthInfo } }>();
  app.use("/mcp", bearerGuard({ store, tenants, publicBaseUrl: BASE }));
  app.get("/mcp", (c) => c.json(c.get("auth")));
  const call = (token = accessToken) =>
    app.request("/mcp", { headers: { authorization: `Bearer ${token}` } });
  return { tenants, tenant, user, clientId, call, app };
}

describe("bearerGuard", () => {
  it("sets AuthInfo with tenantId and role", async () => {
    const { call, tenant, user, clientId } = await setup();
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clientId,
      scope: "mcp",
      userId: user.id,
      tenantId: tenant.id,
      role: "member",
    });
  });

  it("401 for a token of a revoked tenant", async () => {
    const { call, tenants, tenant } = await setup();
    tenants.setStatus(tenant.id, "revoked");
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("401 after the user's tenant is deleted", async () => {
    const { call, tenants, tenant } = await setup();
    tenants.deleteTenant(tenant.id);
    expect((await call()).status).toBe(401);
  });

  it("401 without a token omits the error code", async () => {
    const { app } = await setup();
    const res = await app.request("/mcp");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
  });
});
