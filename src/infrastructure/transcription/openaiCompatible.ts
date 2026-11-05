import { TRANSCRIPTION_MESSAGES, TranscriptionError } from "../../domain/errors.js";
import type { Transcriber } from "../../domain/ports/Transcriber.js";

export { TRANSCRIPTION_MESSAGES };

/** A provider gets this long to answer one transcription. */
export const TRANSCRIPTION_TIMEOUT_MS = 60_000;

/** What the provider reported for one transcription; null when it did not say. */
export interface TranscriptionUsage {
  seconds: number | null;
  costUsd: number | null;
}

export interface OpenAiCompatibleOptions {
  /** Base URL without trailing slash, e.g. `https://openrouter.ai/api/v1`. */
  apiUrl: string;
  apiKey: string;
  model: string;
  language: string | null;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Called once per successful transcription with the provider's `usage` (OpenRouter sends it). */
  onUsage?: (usage: TranscriptionUsage) => void;
}

const amount = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * `POST {apiUrl}/audio/transcriptions` as OpenAI-style multipart (`file`, `model`, optional
 * `language`), answered with `{ text }` and, from OpenRouter, `usage.seconds` / `usage.cost`. Works with OpenRouter, OpenAI and Groq. Redirects are
 * refused (the key must not follow them). Every failure becomes a `TranscriptionError` with a
 * fixed message: provider bodies, the URL and the key never reach callers or logs.
 */
export function createOpenAiCompatibleTranscriber(opts: OpenAiCompatibleOptions): Transcriber {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS;
  const endpoint = `${opts.apiUrl}/audio/transcriptions`;

  return {
    async transcribe(audio) {
      const form = new FormData();
      const type = (audio.mimetype.split(";")[0] ?? "").trim().toLowerCase();
      form.append(
        "file",
        new Blob([audio.bytes as Uint8Array<ArrayBuffer>], { type }),
        audio.filename,
      );
      form.append("model", opts.model);
      if (opts.language) form.append("language", opts.language);
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}` },
          body: form,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new TranscriptionError("failed");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        const s = res.status;
        if (s === 401 || s === 403) throw new TranscriptionError("auth", s);
        if (s === 429) throw new TranscriptionError("rateLimited", s);
        // Wrong URL or model: retrying will not help.
        if (s === 400 || s === 404 || s === 405 || s === 422)
          throw new TranscriptionError("config", s);
        throw new TranscriptionError("failed", s);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new TranscriptionError("failed", res.status);
      }
      const text = (body as { text?: unknown } | null)?.text;
      if (typeof text !== "string") throw new TranscriptionError("failed", res.status);
      const usage = (body as { usage?: { seconds?: unknown; cost?: unknown } | null }).usage;
      try {
        opts.onUsage?.({ seconds: amount(usage?.seconds), costUsd: amount(usage?.cost) });
      } catch {
        // Accounting must never cost the caller its transcript.
      }
      return text.trim();
    },
  };
}
