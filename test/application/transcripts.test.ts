import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTranscriptionService,
  DISABLED_TRANSCRIPTION,
  type TranscriptionOptions,
} from "../../src/application/transcripts.js";
import { InvalidInputError, TranscriptionError } from "../../src/domain/errors.js";
import type { NormalizedMessage } from "../../src/domain/message.js";
import type { Transcriber } from "../../src/domain/ports/Transcriber.js";
import { openCacheDatabase } from "../../src/infrastructure/cache/sqliteMessageStore.js";
import { createSqliteTranscriptStore } from "../../src/infrastructure/cache/sqliteTranscriptStore.js";
import { createWahaAudioSource } from "../../src/infrastructure/transcription/wahaAudioSource.js";
import { gowsMapper } from "../../src/infrastructure/waha/engines/gows.js";
import { type InMemoryData, rawText, rawVoice } from "../fakes/InMemoryWahaGateway.js";
import { ANA, gateway, ME_PHONE, type Raw } from "./helpers.js";

const URL_OF = (id: string) => `http://waha/api/files/${id}`;
const T0 = 1793286000;

/** Voice notes `v1..vN` in ANA's chat, newest first (v1 is the newest). */
function voices(n: number, seconds = 5): Raw[] {
  return Array.from({ length: n }, (_, i) =>
    rawVoice(`v${i + 1}`, T0 - i * 60, {
      url: URL_OF(`v${i + 1}`),
      chat: ANA,
      sender: ANA,
      seconds,
    }),
  );
}

function filesFor(raws: Raw[]): NonNullable<InMemoryData["media"]> {
  const media: NonNullable<InMemoryData["media"]> = {};
  for (const r of raws) {
    const url = (r.media as { url?: string } | null)?.url;
    if (url)
      media[url] = { bytes: new Uint8Array(100).fill(7), mimetype: "audio/ogg; codecs=opus" };
  }
  return media;
}

/** Fake provider: answers "transcript of <file-bytes-length>" per call, records calls. */
class FakeTranscriber implements Transcriber {
  calls = 0;
  active = 0;
  maxActive = 0;
  failOn = new Set<number>();
  delayMs = 0;
  error: Error | null = null;
  async transcribe(audio: { bytes: Uint8Array; mimetype: string; filename: string }) {
    const n = ++this.calls;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      if (this.error) throw this.error;
      if (this.failOn.has(n)) throw new TranscriptionError("failed");
      return `transcript #${n} (${audio.bytes.length} bytes, ${audio.filename})`;
    } finally {
      this.active--;
    }
  }
}

function setup(
  raws: Raw[],
  over: Partial<TranscriptionOptions> = {},
  data: Partial<InMemoryData> = {},
) {
  const gw = gateway({ messages: { [ANA]: raws }, media: filesFor(raws), ...data });
  const db = over.store ? null : openCacheDatabase(":memory:");
  const store = over.store ?? createSqliteTranscriptStore(db as NonNullable<typeof db>);
  const transcriber = (over.transcriber as FakeTranscriber | undefined) ?? new FakeTranscriber();
  const service = createTranscriptionService({
    gateway: gw,
    audio: createWahaAudioSource(gw, { maxBytes: 10_000, idleTimeoutMs: 50 }),
    store,
    transcriber,
    session: "default",
    maxSeconds: 300,
    maxPerCall: 20,
    ...over,
  });
  const messages = () => raws.map((r) => gowsMapper.message(r));
  return { gw, store, transcriber, service, messages };
}

const transcripts = (ms: NormalizedMessage[]) => ms.map((m) => m.transcript);

describe("transcription service: automatic voice notes", () => {
  it("the disabled service changes nothing and calls nobody", async () => {
    const raws = voices(2);
    const gw = gateway({ messages: { [ANA]: raws }, media: filesFor(raws) });
    const ms = raws.map((r) => gowsMapper.message(r));
    expect(await DISABLED_TRANSCRIPTION.annotate(ms)).toEqual([]);
    await DISABLED_TRANSCRIPTION.attachStored(ms);
    expect(transcripts(ms)).toEqual([null, null]);
    expect(gw.calls).toEqual([]);
    expect(DISABLED_TRANSCRIPTION.enabled).toBe(false);
  });

  it("transcribes voice notes and leaves text, plain audio and long notes alone", async () => {
    const raws = [
      rawText("t1", T0 + 60, "hola", { chat: ANA, sender: ANA }),
      rawVoice("v1", T0, { url: URL_OF("v1"), chat: ANA, sender: ANA, seconds: 12 }),
      rawVoice("a1", T0 - 10, { url: URL_OF("a1"), chat: ANA, sender: ANA, ptt: false }),
      rawVoice("long", T0 - 20, { url: URL_OF("long"), chat: ANA, sender: ANA, seconds: 301 }),
      rawVoice("nolen", T0 - 30, { url: URL_OF("nolen"), chat: ANA, sender: ANA, seconds: null }),
    ];
    const s = setup(raws);
    const ms = s.messages();
    const notes = await s.service.annotate(ms);
    expect(transcripts(ms)).toEqual([
      null,
      "transcript #1 (100 bytes, voice.ogg)",
      null,
      null,
      null,
    ]);
    expect(s.transcriber.calls).toBe(1);
    expect(notes).toEqual([
      "2 voice notes longer than 300 s (or of unknown length) were not transcribed automatically; use transcribe_audio with their media_id.",
    ]);
  });

  it("caps NEW transcriptions per call (newest first); stored ones are attached for free", async () => {
    const raws = voices(5);
    const s = setup(raws, { maxPerCall: 2 });
    const first = s.messages();
    const notes = await s.service.annotate(first);
    expect(s.transcriber.calls).toBe(2);
    expect(transcripts(first).map((t) => t !== null)).toEqual([true, true, false, false, false]);
    expect(notes).toEqual([
      "3 voice notes were not transcribed (limit of 2 new transcriptions per call); use transcribe_audio with their media_id.",
    ]);
    const second = s.messages();
    await s.service.annotate(second);
    expect(s.transcriber.calls).toBe(4);
    expect(transcripts(second).map((t) => t !== null)).toEqual([true, true, true, true, false]);
    expect(second[0]?.transcript).toBe(first[0]?.transcript);
  });

  it("MAX_PER_CALL=0 transcribes nothing automatically but still attaches stored transcripts", async () => {
    const raws = voices(2);
    const s = setup(raws, { maxPerCall: 0 });
    const r = await s.service.transcribeMedia(
      gowsMapper.message(raws[1] as Raw).attachment?.mediaId as string,
      gowsMapper,
    );
    expect(r).toMatchObject({ cached: false });
    const ms = s.messages();
    const notes = await s.service.annotate(ms);
    expect(s.transcriber.calls).toBe(1);
    expect(transcripts(ms)).toEqual([null, "transcript #1 (100 bytes, voice.ogg)"]);
    expect(notes).toEqual([
      "Automatic transcription is off (TRANSCRIPTION_MAX_PER_CALL=0); use transcribe_audio for a specific voice note.",
    ]);
  });

  it("failures are not fatal: transcript stays null and a coverage note counts them", async () => {
    const raws = voices(3);
    // v3's file is gone on WAHA.
    const media = filesFor(raws);
    delete media[URL_OF("v3")];
    const s = setup(raws, {}, { media });
    s.transcriber.failOn.add(2);
    const ms = s.messages();
    const notes = await s.service.annotate(ms);
    expect(transcripts(ms).filter((t) => t === null)).toHaveLength(2);
    expect(notes).toEqual(["2 voice notes could not be transcribed."]);
  });

  it("stops calling the provider in this call after it rejects the key", async () => {
    const raws = voices(6);
    const s = setup(raws);
    s.transcriber.error = new TranscriptionError("auth");
    const notes = await s.service.annotate(s.messages());
    expect(s.transcriber.calls).toBeLessThanOrEqual(3);
    expect(notes).toEqual(["6 voice notes could not be transcribed."]);
  });

  it("runs at most 3 transcriptions at once", async () => {
    const raws = voices(8);
    const s = setup(raws);
    s.transcriber.delayMs = 10;
    await s.service.annotate(s.messages());
    expect(s.transcriber.calls).toBe(8);
    expect(s.transcriber.maxActive).toBe(3);
  });

  it("never transcribes the same message twice, even from concurrent calls", async () => {
    const raws = voices(1);
    const s = setup(raws);
    s.transcriber.delayMs = 20;
    const a = s.messages();
    const b = s.messages();
    const dup = s.messages();
    await Promise.all([s.service.annotate([...a, ...dup]), s.service.annotate(b)]);
    expect(s.transcriber.calls).toBe(1);
    expect(transcripts([...a, ...b, ...dup])).toEqual(
      Array(3).fill("transcript #1 (100 bytes, voice.ogg)"),
    );
  });

  it("keeps transcripts across a reopen of cache.db (never paid twice)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-transcripts-"));
    dirs.push(dir);
    const file = path.join(dir, "cache.db");
    const raws = voices(1);
    const db1 = openCacheDatabase(file);
    const first = setup(raws, { store: createSqliteTranscriptStore(db1) });
    await first.service.annotate(first.messages());
    db1.close();
    const second = setup(raws, { store: createSqliteTranscriptStore(openCacheDatabase(file)) });
    const ms = second.messages();
    await second.service.annotate(ms);
    expect(second.transcriber.calls).toBe(0);
    expect(ms[0]?.transcript).toBe("transcript #1 (100 bytes, voice.ogg)");
  });

  it("a different WhatsApp account wipes the stored transcripts before any is served", async () => {
    const raws = voices(1);
    const store = createSqliteTranscriptStore(openCacheDatabase(":memory:"));
    store.resetForOwner("default|someone-else@c.us");
    const key = gowsMapper.message(raws[0] as Raw).attachment?.mediaId as string;
    const parsed = JSON.parse(Buffer.from(key, "base64url").toString()) as { c: string; m: string };
    store.put(parsed.c, parsed.m, "someone else's words");
    const s = setup(raws, { store });
    const ms = s.messages();
    await s.service.attachStored(ms);
    expect(ms[0]?.transcript).toBeNull();
    expect(store.getOwner()).toBe(`default|${ME_PHONE}`);
  });

  it("without a verifiable account it transcribes nothing and says so", async () => {
    const raws = voices(1);
    const s = setup(raws);
    s.gw.getMe = async () => {
      throw new Error("down");
    };
    const ms = s.messages();
    expect(await s.service.annotate(ms)).toEqual([
      "Voice notes were not transcribed: the WhatsApp account could not be verified.",
    ]);
    expect(s.transcriber.calls).toBe(0);
  });
});

describe("transcription service: on demand (transcribe_audio)", () => {
  it("transcribes any audio or voice note of any length, then serves it from the store", async () => {
    const raws = [
      rawVoice("long", T0, { url: URL_OF("long"), chat: ANA, sender: ANA, seconds: 3600 }),
      rawVoice("mp3", T0 - 1, {
        url: URL_OF("mp3"),
        chat: ANA,
        sender: ANA,
        ptt: false,
        mimetype: "audio/mpeg",
      }),
    ];
    const s = setup(raws);
    const [long, mp3] = s.messages().map((m) => m.attachment?.mediaId as string);
    expect(await s.service.transcribeMedia(long as string, gowsMapper)).toEqual({
      status: "ok",
      transcript: "transcript #1 (100 bytes, voice.ogg)",
      cached: false,
      durationSeconds: 3600,
    });
    expect(await s.service.transcribeMedia(mp3 as string, gowsMapper)).toMatchObject({
      transcript: "transcript #2 (100 bytes, audio.mp3)",
    });
    const calls = s.gw.calls.length;
    expect(await s.service.transcribeMedia(long as string, gowsMapper)).toEqual({
      status: "ok",
      transcript: "transcript #1 (100 bytes, voice.ogg)",
      cached: true,
    });
    expect(s.gw.calls.length).toBe(calls);
    expect(s.transcriber.calls).toBe(2);
  });

  it("reports gone files, refuses non-audio and files above MEDIA_MAX_BYTES", async () => {
    const image: Raw = {
      ...rawText("img", T0, "", { chat: ANA, sender: ANA }),
      media: { url: URL_OF("img"), mimetype: "image/jpeg" },
      _data: { Info: {}, Message: { imageMessage: { mimetype: "image/jpeg", fileLength: 5 } } },
    };
    const raws = [
      rawVoice("gone", T0, { url: URL_OF("gone"), chat: ANA, sender: ANA }),
      rawVoice("big", T0 - 1, { url: URL_OF("big"), chat: ANA, sender: ANA }),
      image,
    ];
    const s = setup(
      raws,
      {},
      {
        media: {
          [URL_OF("big")]: { bytes: new Uint8Array(20_000), mimetype: "audio/ogg", length: null },
          [URL_OF("img")]: { bytes: new Uint8Array(5), mimetype: "image/jpeg" },
        },
      },
    );
    const [gone, big, img] = s.messages().map((m) => m.attachment?.mediaId as string);
    expect(await s.service.transcribeMedia(gone as string, gowsMapper)).toEqual({ status: "gone" });
    await expect(s.service.transcribeMedia(img as string, gowsMapper)).rejects.toThrow(
      InvalidInputError,
    );
    await expect(s.service.transcribeMedia(big as string, gowsMapper)).rejects.toThrow(
      /MEDIA_MAX_BYTES/,
    );
    await expect(s.service.transcribeMedia("not-a-media-id", gowsMapper)).rejects.toThrow(
      InvalidInputError,
    );
    expect(s.transcriber.calls).toBe(0);
  });

  it("propagates provider errors with their fixed message", async () => {
    const raws = voices(1);
    const s = setup(raws);
    s.transcriber.error = new TranscriptionError("rateLimited");
    const id = s.messages()[0]?.attachment?.mediaId as string;
    await expect(s.service.transcribeMedia(id, gowsMapper)).rejects.toBeInstanceOf(
      TranscriptionError,
    );
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
