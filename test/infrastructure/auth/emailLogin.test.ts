import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { authenticateLogin } from "../../../src/infrastructure/auth/login.js";
import {
  credentialFields,
  HTML_SECURITY_HEADERS,
  layout,
} from "../../../src/infrastructure/auth/loginPage.js";
import { createLoginLimiter } from "../../../src/infrastructure/auth/rateLimit.js";
import { openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";

const PASSWORD = "a long enough password";

async function setup() {
  const tenants = createSqliteTenantStore(openAuthDatabase(":memory:"), () => 1);
  const t = tenants.createTenant({ displayName: "Ana", wahaSession: "t_ana", wrappedDek: "x" });
  const user = (await tenants.createUser({
    tenantId: t.id,
    username: "ana",
    password: PASSWORD,
    role: "member",
  })) as {
    id: string;
  };
  tenants.setEmail(user.id, "ana@example.com");
  const app = new Hono();
  const limiter = createLoginLimiter();
  app.post("/login", async (c) => {
    const result = await authenticateLogin(c, new URLSearchParams(await c.req.text()), {
      tenants,
      limiter,
    });
    return c.text(typeof result === "string" ? result : `ok:${result.username}`);
  });
  let ip = 0;
  /** Every attempt comes from a new address, so only the per-account limit can block it. */
  const login = async (username: string, password = PASSWORD) =>
    (
      await app.request("/login", {
        method: "POST",
        headers: { "x-forwarded-for": `10.0.0.${++ip}` },
        body: new URLSearchParams({ username, password }).toString(),
      })
    ).text();
  return { login };
}

describe("login with email or username", () => {
  it("accepts the username, as before", async () => {
    expect(await (await setup()).login("ana")).toBe("ok:ana");
  });

  it("accepts the account's email, in any case", async () => {
    const s = await setup();
    expect(await s.login("Ana@Example.com")).toBe("ok:ana");
    expect(await s.login(" ana@example.com ")).toBe("ok:ana");
  });

  it("refuses a wrong password or an unknown email the same way", async () => {
    const s = await setup();
    expect(await s.login("ana@example.com", "wrong password!!")).toBe("invalid");
    expect(await s.login("nobody@example.com")).toBe("invalid");
  });
});

describe("login limit per account", () => {
  it("counts failures by email and by username against the same account", async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++)
      expect(await s.login("ana@example.com", "wrong password!!")).toBe("invalid");
    expect(await s.login("ana", "wrong password!!")).toBe("blocked");
    expect(await s.login("ana")).toBe("blocked");
  });
});

describe("show-password toggle", () => {
  it("every sign-in form has a toggle next to the password", () => {
    const html = credentialFields();
    expect(html).toContain('<label for="username">Correo o usuario</label>');
    expect(html).toMatch(
      /<input id="password"[^>]*>\s*<button type="button" class="pw-toggle"[^>]*aria-label="Mostrar contraseña"/,
    );
  });

  it("the page script is the only one the CSP allows, by its hash", () => {
    const page = layout("T", credentialFields());
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
    expect(scripts).toHaveLength(1);
    const hash = createHash("sha256")
      .update(scripts[0] as string)
      .digest("base64");
    const csp = HTML_SECURITY_HEADERS["Content-Security-Policy"] as string;
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(csp).not.toContain("unsafe-inline' 'sha");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  });
});
