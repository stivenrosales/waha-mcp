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
}

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

const envSchema = z.object({
  WAHA_API_URL: required("WAHA_API_URL")
    .refine(isValidUrl, "WAHA_API_URL must be a valid URL.")
    .transform(stripTrailingSlashes),
  WAHA_API_KEY: required("WAHA_API_KEY"),
  PUBLIC_BASE_URL: required("PUBLIC_BASE_URL")
    .refine(isValidUrl, "PUBLIC_BASE_URL must be a valid URL.")
    .refine(isSecureOrLocal, "PUBLIC_BASE_URL must use https (http is only allowed for localhost).")
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
  };
}
