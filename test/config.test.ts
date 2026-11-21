import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");

const minimal = {
  WAHA_API_URL: "http://waha:3000",
  WAHA_API_KEY: "k",
  PUBLIC_BASE_URL: "https://mcp.example.com",
  MASTER_KEY: KEY_B64,
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "correct horse battery",
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
    expect(c.cacheEnabled).toBe(true);
    expect(c.cacheRefreshHours).toBe(48);
    expect(c.cacheRetentionDays).toBe(90);
  });

  it("reads CACHE_RETENTION_DAYS, falls back to the legacy CACHE_MAX_AGE_DAYS, rejects bad values", () => {
    expect(loadConfig({ ...minimal, CACHE_RETENTION_DAYS: "30" }).cacheRetentionDays).toBe(30);
    expect(loadConfig({ ...minimal, CACHE_RETENTION_DAYS: "0" }).cacheRetentionDays).toBe(0);
    expect(loadConfig({ ...minimal, CACHE_RETENTION_DAYS: "" }).cacheRetentionDays).toBe(90);
    // The legacy name still works when the new one is unset (an explicit 0 keeps data forever).
    expect(loadConfig({ ...minimal, CACHE_MAX_AGE_DAYS: "0" }).cacheRetentionDays).toBe(0);
    expect(
      loadConfig({ ...minimal, CACHE_MAX_AGE_DAYS: "7", CACHE_RETENTION_DAYS: "45" })
        .cacheRetentionDays,
    ).toBe(45);
    expect(() => loadConfig({ ...minimal, CACHE_RETENTION_DAYS: "-1" })).toThrow(
      /CACHE_RETENTION_DAYS/,
    );
    expect(() => loadConfig({ ...minimal, CACHE_RETENTION_DAYS: "forever" })).toThrow(
      /CACHE_RETENTION_DAYS/,
    );
  });

  it("reads the cache settings and rejects invalid values", () => {
    const c = loadConfig({
      ...minimal,
      CACHE_ENABLED: "false",
      CACHE_REFRESH_HOURS: "6",
      CACHE_MAX_AGE_DAYS: "30",
    });
    expect(c.cacheEnabled).toBe(false);
    expect(c.cacheRefreshHours).toBe(6);
    expect(c.cacheRetentionDays).toBe(30);
    expect(loadConfig({ ...minimal, CACHE_ENABLED: "true" }).cacheEnabled).toBe(true);
    expect(loadConfig({ ...minimal, CACHE_ENABLED: "" }).cacheEnabled).toBe(true);
    expect(() => loadConfig({ ...minimal, CACHE_ENABLED: "yes" })).toThrow(/CACHE_ENABLED/);
    expect(() => loadConfig({ ...minimal, CACHE_REFRESH_HOURS: "0" })).toThrow(
      /CACHE_REFRESH_HOURS/,
    );
    expect(() => loadConfig({ ...minimal, CACHE_REFRESH_HOURS: "1.5" })).toThrow(
      /CACHE_REFRESH_HOURS/,
    );
    expect(() => loadConfig({ ...minimal, CACHE_MAX_AGE_DAYS: "-1" })).toThrow(
      /CACHE_MAX_AGE_DAYS/,
    );
    expect(() => loadConfig({ ...minimal, CACHE_MAX_AGE_DAYS: "forever" })).toThrow(
      /CACHE_MAX_AGE_DAYS/,
    );
  });

  it("defaults the upload limits and rejects non-positive values", () => {
    const c = loadConfig(minimal);
    expect(c.uploadMaxBytes).toBe(67108864);
    expect(c.uploadTtlSeconds).toBe(900);
    const custom = loadConfig({ ...minimal, UPLOAD_MAX_BYTES: "1024", UPLOAD_TTL_SECONDS: "60" });
    expect(custom.uploadMaxBytes).toBe(1024);
    expect(custom.uploadTtlSeconds).toBe(60);
    expect(() => loadConfig({ ...minimal, UPLOAD_MAX_BYTES: "0" })).toThrow(/UPLOAD_MAX_BYTES/);
    expect(() => loadConfig({ ...minimal, UPLOAD_TTL_SECONDS: "x" })).toThrow(/UPLOAD_TTL_SECONDS/);
  });

  it("reads MEDIA_MAX_BYTES and rejects non-positive values", () => {
    expect(loadConfig({ ...minimal, MEDIA_MAX_BYTES: "2048" }).mediaMaxBytes).toBe(2048);
    expect(() => loadConfig({ ...minimal, MEDIA_MAX_BYTES: "0" })).toThrow(/MEDIA_MAX_BYTES/);
    expect(() => loadConfig({ ...minimal, MEDIA_MAX_BYTES: "lots" })).toThrow(/MEDIA_MAX_BYTES/);
  });

  it("leaves transcription off unless all three TRANSCRIPTION_* variables are set", () => {
    expect(loadConfig(minimal).transcription).toBeNull();
    const c = loadConfig({
      ...minimal,
      TRANSCRIPTION_API_URL: "https://openrouter.ai/api/v1/",
      TRANSCRIPTION_API_KEY: "sk-or-secret",
      TRANSCRIPTION_MODEL: "openai/whisper-large-v3-turbo",
    });
    expect(c.transcription).toEqual({
      apiUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-secret",
      model: "openai/whisper-large-v3-turbo",
      language: null,
      maxSeconds: 300,
      maxPerCall: 20,
    });
    const tuned = loadConfig({
      ...minimal,
      TRANSCRIPTION_API_URL: "http://localhost:9999/v1",
      TRANSCRIPTION_API_KEY: "k2",
      TRANSCRIPTION_MODEL: "m",
      TRANSCRIPTION_LANGUAGE: "es",
      TRANSCRIPTION_MAX_SECONDS: "60",
      TRANSCRIPTION_MAX_PER_CALL: "0",
    }).transcription;
    expect(tuned).toMatchObject({ language: "es", maxSeconds: 60, maxPerCall: 0 });
  });

  it("trims and validates TRANSCRIPTION_LANGUAGE as an ISO 639 code", () => {
    const on = {
      ...minimal,
      TRANSCRIPTION_API_URL: "https://api.example.com/v1",
      TRANSCRIPTION_API_KEY: "k",
      TRANSCRIPTION_MODEL: "m",
    };
    expect(loadConfig({ ...on, TRANSCRIPTION_LANGUAGE: "  es " }).transcription?.language).toBe(
      "es",
    );
    expect(loadConfig({ ...on, TRANSCRIPTION_LANGUAGE: "spa" }).transcription?.language).toBe(
      "spa",
    );
    expect(loadConfig({ ...on, TRANSCRIPTION_LANGUAGE: "   " }).transcription?.language).toBeNull();
    for (const bad of ["es   # optional hint", "spanish", "e", "es-PE", "ES"])
      expect(() => loadConfig({ ...on, TRANSCRIPTION_LANGUAGE: bad })).toThrow(
        /TRANSCRIPTION_LANGUAGE must be/,
      );
  });

  it("rejects a partial transcription config naming the missing variables, never the values", () => {
    const secret = "sk-or-very-secret";
    let message = "";
    try {
      loadConfig({ ...minimal, TRANSCRIPTION_API_KEY: secret });
      expect.unreachable();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("TRANSCRIPTION_API_URL");
    expect(message).toContain("TRANSCRIPTION_MODEL");
    expect(message).not.toContain("TRANSCRIPTION_API_KEY is");
    expect(message).not.toContain(secret);
    expect(() =>
      loadConfig({
        ...minimal,
        TRANSCRIPTION_API_URL: "https://x.example",
        TRANSCRIPTION_MODEL: "m",
      }),
    ).toThrow(/TRANSCRIPTION_API_KEY/);
  });

  it("treats whitespace-only TRANSCRIPTION_* values as unset and trims the rest", () => {
    expect(
      loadConfig({
        ...minimal,
        TRANSCRIPTION_API_URL: "  ",
        TRANSCRIPTION_API_KEY: " ",
        TRANSCRIPTION_MODEL: "\t",
      }).transcription,
    ).toBeNull();
    expect(() =>
      loadConfig({
        ...minimal,
        TRANSCRIPTION_API_URL: "https://x.example",
        TRANSCRIPTION_API_KEY: "   ",
        TRANSCRIPTION_MODEL: "m",
      }),
    ).toThrow(/TRANSCRIPTION_API_KEY/);
    expect(
      loadConfig({
        ...minimal,
        TRANSCRIPTION_API_URL: " https://x.example/v1/ ",
        TRANSCRIPTION_API_KEY: " k ",
        TRANSCRIPTION_MODEL: " m ",
      }).transcription,
    ).toMatchObject({ apiUrl: "https://x.example/v1", apiKey: "k", model: "m" });
  });

  it("rejects a non-https transcription URL (except localhost) and invalid limits", () => {
    const on = { ...minimal, TRANSCRIPTION_API_KEY: "k", TRANSCRIPTION_MODEL: "m" };
    expect(() => loadConfig({ ...on, TRANSCRIPTION_API_URL: "http://api.example.com/v1" })).toThrow(
      /TRANSCRIPTION_API_URL must use https/,
    );
    expect(() => loadConfig({ ...on, TRANSCRIPTION_API_URL: "not a url" })).toThrow(
      /TRANSCRIPTION_API_URL/,
    );
    const url = { ...on, TRANSCRIPTION_API_URL: "https://api.example.com/v1" };
    expect(() => loadConfig({ ...url, TRANSCRIPTION_MAX_SECONDS: "0" })).toThrow(
      /TRANSCRIPTION_MAX_SECONDS/,
    );
    expect(() => loadConfig({ ...url, TRANSCRIPTION_MAX_PER_CALL: "-1" })).toThrow(
      /TRANSCRIPTION_MAX_PER_CALL/,
    );
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

  it("never echoes the key, even when the key is the offending value of other variables", () => {
    const key = "super-secret-value";
    try {
      loadConfig({
        WAHA_API_KEY: key,
        WAHA_API_URL: key,
        PUBLIC_BASE_URL: `http://${key}.example`,
        PORT: key,
        TIMEZONE: key,
        STATS_MAX_MESSAGES: key,
        MEDIA_LINK_TTL_SECONDS: key,
      });
      expect.unreachable();
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("Invalid configuration");
      expect(message).toMatch(/WAHA_API_URL[\s\S]*PUBLIC_BASE_URL[\s\S]*PORT[\s\S]*TIMEZONE/);
      expect(message).not.toContain(key);
    }
  });

  describe("multi-tenancy settings", () => {
    const { MASTER_KEY: _k, ADMIN_USERNAME: _u, ADMIN_PASSWORD: _p, ...base } = minimal;

    it("requires MASTER_KEY, ADMIN_USERNAME and ADMIN_PASSWORD", () => {
      let message = "";
      try {
        loadConfig(base);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/MASTER_KEY/);
      expect(message).toMatch(/ADMIN_USERNAME/);
      expect(message).toMatch(/ADMIN_PASSWORD/);
    });

    it("exposes the master key and admin seed", () => {
      const c = loadConfig(minimal);
      expect(c.masterKey.equals(Buffer.alloc(32, 7))).toBe(true);
      expect(c.masterKeyPrevious).toBeNull();
      expect(c.adminUsername).toBe("admin");
      expect(c.adminPassword).toBe("correct horse battery");
      expect(c.adminPasswordReset).toBe(false);
    });

    it("trims ADMIN_USERNAME and holds it to the invite form's username rules", () => {
      expect(loadConfig({ ...minimal, ADMIN_USERNAME: "  admin.one  " }).adminUsername).toBe(
        "admin.one",
      );
      const rule = "ADMIN_USERNAME must be 3 to 32 letters, digits, dots, dashes or underscores.";
      for (const bad of ["ad", "a".repeat(33), "bad name", "admin@home", "   "]) {
        expect(() => loadConfig({ ...minimal, ADMIN_USERNAME: bad })).toThrow(rule);
      }
      expect(loadConfig({ ...minimal, ADMIN_USERNAME: "a".repeat(32) }).adminUsername).toBe(
        "a".repeat(32),
      );
    });

    it("rejects ADMIN_PASSWORD shorter than 12 chars", () => {
      expect(() => loadConfig({ ...minimal, ADMIN_PASSWORD: "short-pass1" })).toThrow(
        /ADMIN_PASSWORD must be at least 12 characters/,
      );
      expect(loadConfig({ ...minimal, ADMIN_PASSWORD: "exactly12chr" }).adminPassword).toBe(
        "exactly12chr",
      );
    });

    it("rejects a MASTER_KEY that is not 32 bytes without echoing the value", () => {
      const bad = Buffer.alloc(16, 1).toString("base64");
      let message = "";
      try {
        loadConfig({ ...minimal, MASTER_KEY: bad });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/MASTER_KEY must be 32 bytes/);
      expect(message).not.toContain(bad);
    });

    it("ADMIN_PASSWORD_RESET defaults to false and accepts 1/true", () => {
      expect(loadConfig({ ...minimal, ADMIN_PASSWORD_RESET: "" }).adminPasswordReset).toBe(false);
      expect(loadConfig({ ...minimal, ADMIN_PASSWORD_RESET: "0" }).adminPasswordReset).toBe(false);
      expect(loadConfig({ ...minimal, ADMIN_PASSWORD_RESET: "false" }).adminPasswordReset).toBe(
        false,
      );
      expect(loadConfig({ ...minimal, ADMIN_PASSWORD_RESET: "1" }).adminPasswordReset).toBe(true);
      expect(loadConfig({ ...minimal, ADMIN_PASSWORD_RESET: "TRUE" }).adminPasswordReset).toBe(
        true,
      );
      expect(() => loadConfig({ ...minimal, ADMIN_PASSWORD_RESET: "yes" })).toThrow(
        /ADMIN_PASSWORD_RESET/,
      );
    });

    it("MASTER_KEY_PREVIOUS is optional and validated like MASTER_KEY", () => {
      const prev = Buffer.alloc(32, 9).toString("base64");
      const c = loadConfig({ ...minimal, MASTER_KEY_PREVIOUS: prev });
      expect(c.masterKeyPrevious?.equals(Buffer.alloc(32, 9))).toBe(true);
      expect(loadConfig({ ...minimal, MASTER_KEY_PREVIOUS: "" }).masterKeyPrevious).toBeNull();
      const bad = Buffer.alloc(8, 2).toString("base64");
      let message = "";
      try {
        loadConfig({ ...minimal, MASTER_KEY_PREVIOUS: bad });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/MASTER_KEY_PREVIOUS must be 32 bytes/);
      expect(message).not.toContain(bad);
    });
  });
  describe("missions", () => {
    const on = {
      ...minimal,
      OPENROUTER_API_KEY: "sk-or-mission-secret",
      WAHA_WEBHOOK_SECRET: "hook-secret",
    };

    it("missions is null when neither OPENROUTER_API_KEY nor WAHA_WEBHOOK_SECRET is set", () => {
      expect(loadConfig(minimal).missions).toBeNull();
    });

    it("key without secret fails with 'OPENROUTER_API_KEY needs WAHA_WEBHOOK_SECRET …'", () => {
      let message = "";
      try {
        loadConfig({ ...minimal, OPENROUTER_API_KEY: "sk-or-mission-secret" });
        expect.unreachable();
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(
        "OPENROUTER_API_KEY needs WAHA_WEBHOOK_SECRET (missions receive messages through webhooks).",
      );
      expect(message).not.toContain("sk-or-mission-secret");
    });

    it("secret alone turns webhooks on and missions off", () => {
      const c = loadConfig({ ...minimal, WAHA_WEBHOOK_SECRET: " s " });
      expect(c.webhookSecret).toBe("s");
      expect(c.missions).toBeNull();
    });

    it("neither: webhookSecret null", () => {
      expect(loadConfig(minimal).webhookSecret).toBeNull();
    });

    it("with both, missions.webhookSecret equals webhookSecret", () => {
      const c = loadConfig(on);
      expect(c.webhookSecret).toBe("hook-secret");
      expect(c.missions?.webhookSecret).toBe("hook-secret");
    });

    it("defaults: model anthropic/claude-haiku-5.5, budget 1, limits as above", () => {
      expect(loadConfig(on).missions).toEqual({
        openRouterApiKey: "sk-or-mission-secret",
        webhookSecret: "hook-secret",
        model: "anthropic/claude-haiku-5.5",
        monthlyBudgetUsd: 1,
        limits: {
          maxMessagesPerMission: 40,
          maxActivePerTenant: 3,
          maxNewContactsPerDay: 5,
          maxReminders: 2,
          maxRemindersNewContact: 1,
          reminderGapMs: 1_800_000,
          debounceMs: 15_000,
          maxDurationMinutes: 120,
          maxLlmCallsPerMission: 60,
          quietStartHour: 22,
          quietEndHour: 8,
        },
        schedules: {
          maxActivePerTenant: 20,
          defaultRuns: 12,
          maxRuns: 52,
          missedAfterMinutes: 60,
        },
      });
    });

    it("reads every SCHEDULES_* override and refuses a default above the maximum", () => {
      expect(
        loadConfig({
          ...on,
          SCHEDULES_MAX_ACTIVE_PER_TENANT: "5",
          SCHEDULES_DEFAULT_RUNS: "4",
          SCHEDULES_MAX_RUNS: "10",
          SCHEDULES_MISSED_AFTER_MINUTES: "30",
        }).missions?.schedules,
      ).toEqual({ maxActivePerTenant: 5, defaultRuns: 4, maxRuns: 10, missedAfterMinutes: 30 });
      expect(() => loadConfig({ ...on, SCHEDULES_MAX_RUNS: "0" })).toThrow(
        /SCHEDULES_MAX_RUNS must be a positive integer/,
      );
      expect(() => loadConfig({ ...on, SCHEDULES_DEFAULT_RUNS: "60" })).toThrow(
        /SCHEDULES_DEFAULT_RUNS cannot be above SCHEDULES_MAX_RUNS/,
      );
    });

    it("reads every MISSIONS_* override", () => {
      const m = loadConfig({
        ...on,
        MISSIONS_MODEL: "anthropic/claude-sonnet-5.5",
        MISSIONS_MONTHLY_BUDGET_USD: "2.5",
        MISSIONS_MAX_MESSAGES_PER_MISSION: "10",
        MISSIONS_MAX_ACTIVE_PER_TENANT: "1",
        MISSIONS_MAX_NEW_CONTACTS_PER_DAY: "2",
        MISSIONS_MAX_REMINDERS: "0",
        MISSIONS_MAX_REMINDERS_NEW_CONTACT: "0",
        MISSIONS_REMINDER_GAP_MS: "60000",
        MISSIONS_DEBOUNCE_MS: "0",
        MISSIONS_MAX_DURATION_MINUTES: "30",
        MISSIONS_MAX_LLM_CALLS_PER_MISSION: "20",
        MISSIONS_QUIET_START_HOUR: "23",
        MISSIONS_QUIET_END_HOUR: "0",
      }).missions;
      expect(m).toMatchObject({
        model: "anthropic/claude-sonnet-5.5",
        monthlyBudgetUsd: 2.5,
        limits: {
          maxMessagesPerMission: 10,
          maxActivePerTenant: 1,
          maxNewContactsPerDay: 2,
          maxReminders: 0,
          maxRemindersNewContact: 0,
          reminderGapMs: 60000,
          debounceMs: 0,
          maxDurationMinutes: 30,
          maxLlmCallsPerMission: 20,
          quietStartHour: 23,
          quietEndHour: 0,
        },
      });
    });

    it("rejects invalid budgets, limits and hours", () => {
      for (const bad of ["0", "-1", "abc"])
        expect(() => loadConfig({ ...on, MISSIONS_MONTHLY_BUDGET_USD: bad })).toThrow(
          /MISSIONS_MONTHLY_BUDGET_USD must be a positive number/,
        );
      expect(() => loadConfig({ ...on, MISSIONS_MAX_MESSAGES_PER_MISSION: "0" })).toThrow(
        /MISSIONS_MAX_MESSAGES_PER_MISSION/,
      );
      for (const bad of ["24", "-1", "x"])
        expect(() => loadConfig({ ...on, MISSIONS_QUIET_START_HOUR: bad })).toThrow(
          /MISSIONS_QUIET_START_HOUR must be an hour from 0 to 23/,
        );
      expect(() => loadConfig({ ...on, MISSIONS_QUIET_END_HOUR: "25" })).toThrow(
        /MISSIONS_QUIET_END_HOUR must be an hour from 0 to 23/,
      );
    });
  });
});
