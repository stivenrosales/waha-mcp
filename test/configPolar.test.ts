import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const minimal = {
  WAHA_API_URL: "http://waha:3000",
  WAHA_API_KEY: "k",
  PUBLIC_BASE_URL: "https://mcp.example.com",
  MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "correct horse battery",
};
const email = {
  EMAIL_FROM: "Zenbox <hola@usezenbox.com>",
  CLOUDFLARE_ACCOUNT_ID: "acc",
  CLOUDFLARE_EMAIL_API_TOKEN: "cf",
};
const polar = { POLAR_WEBHOOK_SECRET: "whsec_c2VjcmV0", POLAR_ACCESS_TOKEN: "polar_oat_secret" };
const messageOf = (env: Record<string, string>) => {
  try {
    loadConfig(env);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("polar config", () => {
  it("is off by default", () => {
    expect(loadConfig(minimal).polar).toBeNull();
  });

  it("is on with both variables and email, with the production API by default", () => {
    expect(loadConfig({ ...minimal, ...email, ...polar }).polar).toEqual({
      webhookSecret: "whsec_c2VjcmV0",
      accessToken: "polar_oat_secret",
      apiUrl: "https://api.polar.sh",
    });
    expect(
      loadConfig({ ...minimal, ...email, ...polar, POLAR_API_URL: "https://sandbox-api.polar.sh/" })
        .polar?.apiUrl,
    ).toBe("https://sandbox-api.polar.sh");
  });

  it("names a missing half, never the secrets", () => {
    const m = messageOf({ ...minimal, ...email, POLAR_ACCESS_TOKEN: "polar_oat_secret" });
    expect(m).toContain("POLAR_WEBHOOK_SECRET is required when Polar is configured");
    expect(m).not.toContain("polar_oat_secret");
  });

  it("needs email, and refuses MULTI_TENANT=false", () => {
    expect(messageOf({ ...minimal, ...polar })).toContain(
      "Polar needs email (EMAIL_FROM, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL_API_TOKEN): invites are sent by email.",
    );
    expect(messageOf({ ...minimal, ...email, ...polar, MULTI_TENANT: "false" })).toContain(
      "Polar needs MULTI_TENANT on (each customer gets an account).",
    );
  });
});
