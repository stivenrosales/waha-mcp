import { z } from "zod";

/**
 * Validated server configuration. `loadConfig` is pure: it never reads
 * `process.env` itself, so tests can exercise it with arbitrary objects and
 * the entrypoint is the only place that passes `process.env` in.
 */
export interface Config {
  wahaApiUrl: string;
  wahaApiKey: string;
  wahaSession: string;
  publicBaseUrl: string;
  dataDir: string;
  port: number;
  timezone: string;
  statsMaxMessages: number;
  mediaLinkTtlSeconds: number;
  mediaInlineMaxBytes: number;
  /** Largest file `/media/:token` will stream; bigger files get a 413. */
  mediaMaxBytes: number;
  /** Keep a SQLite copy of read messages in `DATA_DIR/cache.db`. */
  cacheEnabled: boolean;
  /** How far back from the newest cached message every sync re-reads (edits, deletions). */
  cacheRefreshHours: number;
  /** Cached messages older than this many days are pruned; 0 keeps them forever. */
  cacheMaxAgeDays: number;
  /** Voice-note transcription via an OpenAI-compatible API; null when off (the default). */
  transcription: TranscriptionConfig | null;
}

export interface TranscriptionConfig {
  /** Base URL; requests go to `{apiUrl}/audio/transcriptions`. */
  apiUrl: string;
  apiKey: string;
  model: string;
  /** ISO-639-1 hint sent as `language`; null lets the provider detect it. */
  language: string | null;
  /** Voice notes longer than this are not transcribed automatically. */
  maxSeconds: number;
  /** NEW automatic transcriptions per tool call; 0 = only on demand (transcribe_audio). */
  maxPerCall: number;
}

const TRANSCRIPTION_REQUIRED = [
  "TRANSCRIPTION_API_URL",
  "TRANSCRIPTION_API_KEY",
  "TRANSCRIPTION_MODEL",
] as const;

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

const isValidUrl = (value: string): boolean => URL.canParse(value);

const isValidTimezone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
};

const isSecureOrLocal = (value: string): boolean => {
  if (!URL.canParse(value)) return true; // reported by the URL check
  const url = new URL(value);
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
};

const required = (name: string) => z.string(`${name} is required.`).min(1, `${name} is required.`);

const positiveInt = (name: string, fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? String(fallback) : v))
    .pipe(
      z
        .string()
        .regex(/^\d+$/, `${name} must be a positive integer.`)
        .transform(Number)
        .refine((n) => n > 0, `${name} must be a positive integer.`),
    );

const nonNegativeInt = (name: string, fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? String(fallback) : v))
    .pipe(z.string().regex(/^\d+$/, `${name} must be a non-negative integer.`).transform(Number));

const boolean = (name: string, fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? String(fallback) : v.toLowerCase()))
    .pipe(
      z
        .enum(["true", "false"], `${name} must be "true" or "false".`)
        .transform((v) => v === "true"),
    );

const envSchema = z
  .object({
    WAHA_API_URL: required("WAHA_API_URL")
      .refine(isValidUrl, "WAHA_API_URL must be a valid URL.")
      .transform(stripTrailingSlashes),
    WAHA_API_KEY: required("WAHA_API_KEY"),
    PUBLIC_BASE_URL: required("PUBLIC_BASE_URL")
      .refine(isValidUrl, "PUBLIC_BASE_URL must be a valid URL.")
      .refine(
        isSecureOrLocal,
        "PUBLIC_BASE_URL must use https (http is only allowed for localhost).",
      )
      .transform(stripTrailingSlashes),
    WAHA_SESSION: z.string().min(1, "WAHA_SESSION must not be empty.").default("default"),
    DATA_DIR: z.string().min(1, "DATA_DIR must not be empty.").default("/data"),
    PORT: positiveInt("PORT", 3000),
    TIMEZONE: z
      .string()
      .refine(isValidTimezone, "TIMEZONE must be a valid IANA time zone (e.g. America/Lima).")
      .default("UTC"),
    STATS_MAX_MESSAGES: positiveInt("STATS_MAX_MESSAGES", 5000),
    MEDIA_LINK_TTL_SECONDS: positiveInt("MEDIA_LINK_TTL_SECONDS", 600),
    MEDIA_INLINE_MAX_BYTES: positiveInt("MEDIA_INLINE_MAX_BYTES", 5242880),
    MEDIA_MAX_BYTES: positiveInt("MEDIA_MAX_BYTES", 104857600),
    CACHE_ENABLED: boolean("CACHE_ENABLED", true),
    CACHE_REFRESH_HOURS: positiveInt("CACHE_REFRESH_HOURS", 48),
    CACHE_MAX_AGE_DAYS: nonNegativeInt("CACHE_MAX_AGE_DAYS", 0),
    TRANSCRIPTION_API_URL: z
      .string()
      .optional()
      .transform((v) => v?.trim())
      .refine((v) => !v || isValidUrl(v), "TRANSCRIPTION_API_URL must be a valid URL.")
      .refine(
        (v) => !v || isSecureOrLocal(v),
        "TRANSCRIPTION_API_URL must use https (http is only allowed for localhost).",
      )
      .transform((v) => (v ? stripTrailingSlashes(v) : undefined)),
    TRANSCRIPTION_API_KEY: z
      .string()
      .optional()
      .transform((v) => v?.trim()),
    TRANSCRIPTION_MODEL: z
      .string()
      .optional()
      .transform((v) => v?.trim()),
    TRANSCRIPTION_LANGUAGE: z.string().optional(),
    TRANSCRIPTION_MAX_SECONDS: positiveInt("TRANSCRIPTION_MAX_SECONDS", 300),
    TRANSCRIPTION_MAX_PER_CALL: nonNegativeInt("TRANSCRIPTION_MAX_PER_CALL", 20),
  })
  .superRefine((env, ctx) => {
    // All three or none: a half-configured provider is a mistake, not "off".
    const set = TRANSCRIPTION_REQUIRED.filter((name) => Boolean(env[name]));
    if (set.length === 0 || set.length === TRANSCRIPTION_REQUIRED.length) return;
    for (const name of TRANSCRIPTION_REQUIRED)
      if (!env[name])
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `${name} is required when transcription is configured (set TRANSCRIPTION_API_URL, TRANSCRIPTION_API_KEY and TRANSCRIPTION_MODEL together).`,
        });
  });

/**
 * Parses the environment into a `Config`. Throws one `Error` listing every
 * invalid variable. Messages never include the offending values, so the API
 * key cannot leak through an error.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `- ${issue.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const v = result.data;
  return {
    wahaApiUrl: v.WAHA_API_URL,
    wahaApiKey: v.WAHA_API_KEY,
    wahaSession: v.WAHA_SESSION,
    publicBaseUrl: v.PUBLIC_BASE_URL,
    dataDir: v.DATA_DIR,
    port: v.PORT,
    timezone: v.TIMEZONE,
    statsMaxMessages: v.STATS_MAX_MESSAGES,
    mediaLinkTtlSeconds: v.MEDIA_LINK_TTL_SECONDS,
    mediaInlineMaxBytes: v.MEDIA_INLINE_MAX_BYTES,
    mediaMaxBytes: v.MEDIA_MAX_BYTES,
    cacheEnabled: v.CACHE_ENABLED,
    cacheRefreshHours: v.CACHE_REFRESH_HOURS,
    cacheMaxAgeDays: v.CACHE_MAX_AGE_DAYS,
    transcription:
      v.TRANSCRIPTION_API_URL && v.TRANSCRIPTION_API_KEY && v.TRANSCRIPTION_MODEL
        ? {
            apiUrl: v.TRANSCRIPTION_API_URL,
            apiKey: v.TRANSCRIPTION_API_KEY,
            model: v.TRANSCRIPTION_MODEL,
            language: v.TRANSCRIPTION_LANGUAGE || null,
            maxSeconds: v.TRANSCRIPTION_MAX_SECONDS,
            maxPerCall: v.TRANSCRIPTION_MAX_PER_CALL,
          }
        : null,
  };
}
