import { TRANSCRIPTION_MESSAGES, TranscriptionError } from "../../domain/errors.js";
import type { Transcriber } from "../../domain/ports/Transcriber.js";

export { TRANSCRIPTION_MESSAGES };

/** A provider gets this long to answer one transcription. */
export const TRANSCRIPTION_TIMEOUT_MS = 60_000;

export interface OpenAiCompatibleOptions {
  /** Base URL without trailing slash, e.g. `https://openrouter.ai/api/v1`. */
  apiUrl: string;
  apiKey: string;
  model: string;
  language: string | null;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * `POST {apiUrl}/audio/transcriptions` as OpenAI-style multipart (`file`, `model`, optional
 * `language`), answered with `{ text }`. Works with OpenRouter, OpenAI and Groq. Redirects are
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
        if (res.status === 401 || res.status === 403) throw new TranscriptionError("auth");
        if (res.status === 429) throw new TranscriptionError("rateLimited");
        throw new TranscriptionError("failed");
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new TranscriptionError("failed");
      }
      const text = (body as { text?: unknown } | null)?.text;
      if (typeof text !== "string") throw new TranscriptionError("failed");
      return text.trim();
    },
  };
}
