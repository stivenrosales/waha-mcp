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
  RESEND_API_KEY: "cf-secret",
};

describe("email config", () => {
  it("is off by default", () => {
    const c = loadConfig(minimal);
    expect(c.email).toBeNull();
    expect(c.adminEmail).toBeNull();
  });

  it("is on when both variables are set", () => {
    const c = loadConfig({ ...minimal, ...email, ADMIN_EMAIL: " Owner@Example.com " });
    expect(c.email).toEqual({ from: "Zenbox <hola@usezenbox.com>", apiKey: "cf-secret" });
    expect(c.adminEmail).toBe("owner@example.com");
  });

  it("names each missing variable when only some are set, without the token", () => {
    let message = "";
    try {
      loadConfig({ ...minimal, RESEND_API_KEY: "cf-secret" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("EMAIL_FROM is required when email is configured");
    expect(message).not.toContain("RESEND_API_KEY is required");
    expect(message).not.toContain("cf-secret");
  });

  it("rejects an ADMIN_EMAIL that is not an email address", () => {
    expect(() => loadConfig({ ...minimal, ADMIN_EMAIL: "nope" })).toThrow(
      "ADMIN_EMAIL must be an email address.",
    );
  });

  it("keeps the transcription all-or-nothing check working alongside", () => {
    expect(() => loadConfig({ ...minimal, ...email, TRANSCRIPTION_API_KEY: "k" })).toThrow(
      "TRANSCRIPTION_API_URL is required when transcription is configured",
    );
  });
});
