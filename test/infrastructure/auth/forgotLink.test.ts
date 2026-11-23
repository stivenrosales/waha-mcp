import { describe, expect, it } from "vitest";
import { loginPage } from "../../../src/infrastructure/auth/loginPage.js";

const base = { params: { client_id: "c" }, redirectHost: "claude.ai" };

describe("login page forgot link", () => {
  it("links to /forgot only when password recovery is on", () => {
    expect(loginPage({ ...base, forgotUrl: "/forgot" })).toContain(
      '<a href="/forgot">¿Olvidaste tu contraseña?</a>',
    );
    expect(loginPage(base)).not.toContain("forgot");
  });
});
