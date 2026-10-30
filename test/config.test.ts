import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const minimal = {
  WAHA_API_URL: "http://waha:3000",
  WAHA_API_KEY: "k",
  PUBLIC_BASE_URL: "https://mcp.example.com",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(minimal);
    expect(c.wahaSession).toBe("default");
    expect(c.dataDir).toBe("/data");
    expect(c.port).toBe(3000);
    expect(c.timezone).toBe("UTC");
    expect(c.statsMaxMessages).toBe(5000);
    expect(c.mediaLinkTtlSeconds).toBe(600);
    expect(c.mediaInlineMaxBytes).toBe(5242880);
    expect(c.mediaMaxBytes).toBe(104857600);
  });

  it("reads MEDIA_MAX_BYTES and rejects non-positive values", () => {
    expect(loadConfig({ ...minimal, MEDIA_MAX_BYTES: "2048" }).mediaMaxBytes).toBe(2048);
    expect(() => loadConfig({ ...minimal, MEDIA_MAX_BYTES: "0" })).toThrow(/MEDIA_MAX_BYTES/);
    expect(() => loadConfig({ ...minimal, MEDIA_MAX_BYTES: "lots" })).toThrow(/MEDIA_MAX_BYTES/);
  });

  it("strips trailing slash from URLs", () => {
    const c = loadConfig({
      ...minimal,
      WAHA_API_URL: "http://waha:3000/",
      PUBLIC_BASE_URL: "https://mcp.example.com/",
    });
    expect(c.wahaApiUrl).toBe("http://waha:3000");
    expect(c.publicBaseUrl).toBe("https://mcp.example.com");
  });

  it("rejects invalid timezone", () => {
    expect(() => loadConfig({ ...minimal, TIMEZONE: "Mars/Base" })).toThrow(/TIMEZONE/);
  });

  it("rejects non-https PUBLIC_BASE_URL except localhost", () => {
    expect(() => loadConfig({ ...minimal, PUBLIC_BASE_URL: "http://mcp.example.com" })).toThrow(
      /PUBLIC_BASE_URL/,
    );
    expect(loadConfig({ ...minimal, PUBLIC_BASE_URL: "http://localhost:3000" }).publicBaseUrl).toBe(
      "http://localhost:3000",
    );
  });

  it("reports all missing vars at once", () => {
    expect(() => loadConfig({})).toThrow(/WAHA_API_URL[\s\S]*WAHA_API_KEY[\s\S]*PUBLIC_BASE_URL/);
  });

  it("never echoes the key", () => {
    try {
      loadConfig({ WAHA_API_KEY: "super-secret-value", TIMEZONE: "Mars/Base" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("super-secret-value");
    }
  });
});
