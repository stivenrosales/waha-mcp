import { describe, expect, it } from "vitest";
import { TranscriptionError } from "../../../src/domain/errors.js";
import {
  createOpenAiCompatibleTranscriber,
  TRANSCRIPTION_MESSAGES,
} from "../../../src/infrastructure/transcription/openaiCompatible.js";

const KEY = "sk-or-very-secret";
const audio = {
  bytes: new Uint8Array([79, 103, 103, 83, 1, 2, 3]),
  mimetype: "audio/ogg; codecs=opus",
  filename: "voice.ogg",
};

/** In-process provider: records each request and answers with `respond`. */
function fakeProvider(respond: (req: Request) => Response | Promise<Response>) {
  const seen: { req: Request; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ req, init });
    return respond(req);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("OpenAI-compatible transcription client", () => {
  it("POSTs multipart file/model/language to {url}/audio/transcriptions with the bearer key", async () => {
    const p = fakeProvider(() => json({ text: " hola, ¿cómo estás? ", usage: { seconds: 3 } }));
    const t = createOpenAiCompatibleTranscriber({
      apiUrl: "https://openrouter.ai/api/v1",
      apiKey: KEY,
      model: "openai/whisper-large-v3-turbo",
      language: "es",
      fetch: p.fetch,
    });
    expect(await t.transcribe(audio)).toBe("hola, ¿cómo estás?");
    expect(p.seen).toHaveLength(1);
    const { req, init } = p.seen[0] as { req: Request; init: RequestInit };
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(req.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(req.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = await req.formData();
    const file = form.get("file") as File;
    expect(file.name).toBe("voice.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio.bytes);
    expect(form.get("model")).toBe("openai/whisper-large-v3-turbo");
    expect(form.get("language")).toBe("es");
  });

  it("omits language when none is configured", async () => {
    const p = fakeProvider(() => json({ text: "ok" }));
    const t = createOpenAiCompatibleTranscriber({
      apiUrl: "https://x.example/v1",
      apiKey: KEY,
      model: "m",
      language: null,
      fetch: p.fetch,
    });
    await t.transcribe(audio);
    const form = await (p.seen[0] as { req: Request }).req.formData();
    expect(form.has("language")).toBe(false);
  });

  it.each([
    [401, TRANSCRIPTION_MESSAGES.auth],
    [403, TRANSCRIPTION_MESSAGES.auth],
    [429, TRANSCRIPTION_MESSAGES.rateLimited],
    [500, TRANSCRIPTION_MESSAGES.failed],
    [400, TRANSCRIPTION_MESSAGES.config],
    [404, TRANSCRIPTION_MESSAGES.config],
    [405, TRANSCRIPTION_MESSAGES.config],
    [422, TRANSCRIPTION_MESSAGES.config],
  ])("maps HTTP %i to a fixed message that never contains the key", async (status, message) => {
    const p = fakeProvider(() => json({ error: { message: `bad key ${KEY}` } }, status));
    const t = createOpenAiCompatibleTranscriber({
      apiUrl: "https://x.example/v1",
      apiKey: KEY,
      model: "m",
      language: null,
      fetch: p.fetch,
    });
    const err = await t.transcribe(audio).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptionError);
    expect((err as Error).message).toBe(message);
    expect((err as TranscriptionError).status).toBe(status);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("network failures, timeouts and malformed bodies become the generic message", async () => {
    const cases = [
      fakeProvider(() => {
        throw new TypeError(`fetch failed for ${KEY}`);
      }),
      fakeProvider(() => new Response("<html>not json</html>", { status: 200 })),
      fakeProvider(() => json({ nope: true })),
    ];
    for (const p of cases) {
      const t = createOpenAiCompatibleTranscriber({
        apiUrl: "https://x.example/v1",
        apiKey: KEY,
        model: "m",
        language: null,
        fetch: p.fetch,
      });
      const err = await t.transcribe(audio).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TranscriptionError);
      expect((err as Error).message).toBe(TRANSCRIPTION_MESSAGES.failed);
    }
    const slow = fakeProvider(
      (req) =>
        new Promise<Response>((_, reject) => {
          req.signal.addEventListener("abort", () => reject(req.signal.reason));
        }),
    );
    const t = createOpenAiCompatibleTranscriber({
      apiUrl: "https://x.example/v1",
      apiKey: KEY,
      model: "m",
      language: null,
      fetch: slow.fetch,
      timeoutMs: 20,
    });
    const err = await t.transcribe(audio).catch((e: unknown) => e);
    expect((err as Error).message).toBe(TRANSCRIPTION_MESSAGES.failed);
  });

  it("a 404 is a configuration problem, not a transient one", () => {
    expect(TRANSCRIPTION_MESSAGES.config).toBe(
      "The transcription provider rejected the request — check TRANSCRIPTION_API_URL and TRANSCRIPTION_MODEL.",
    );
    expect(new TranscriptionError("config", 404).kind).toBe("config");
  });
});
