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
const messageOf = (env: Record<string, string>) => {
  try {
    loadConfig(env);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("posthog config", () => {
  it("is off by default", () => {
    expect(loadConfig(minimal).posthog).toBeNull();
  });

  it("is on with the project key, on the US host by default", () => {
    expect(loadConfig({ ...minimal, POSTHOG_API_KEY: " phc_abc " }).posthog).toEqual({
      apiKey: "phc_abc",
      host: "https://us.i.posthog.com",
    });
    expect(
      loadConfig({
        ...minimal,
        POSTHOG_API_KEY: "phc_abc",
        POSTHOG_HOST: "https://eu.i.posthog.com/",
      }).posthog?.host,
    ).toBe("https://eu.i.posthog.com");
  });

  it("refuses a key that is not a project token, and a plain-http host", () => {
    expect(messageOf({ ...minimal, POSTHOG_API_KEY: "phx_personal" })).toContain(
      "POSTHOG_API_KEY must be a project token (phc_…)",
    );
    expect(
      messageOf({
        ...minimal,
        POSTHOG_API_KEY: "phc_abc",
        POSTHOG_HOST: "http://posthog.example.com",
      }),
    ).toContain("POSTHOG_HOST must use https.");
  });
});
