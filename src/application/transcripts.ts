import { InvalidInputError, TranscriptionError } from "../domain/errors.js";
import type { EngineMapper, NormalizedMessage } from "../domain/message.js";
import type { AudioSource } from "../domain/ports/AudioSource.js";
import type { Transcriber } from "../domain/ports/Transcriber.js";
import type { TranscriptStore } from "../domain/ports/TranscriptStore.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";

export const TRANSCRIPTION_NOT_CONFIGURED =
  "Transcription is not configured on this server (set TRANSCRIPTION_API_URL, TRANSCRIPTION_API_KEY, TRANSCRIPTION_MODEL).";

const OWNER_UNVERIFIED =
  "Voice notes were not transcribed: the WhatsApp account could not be verified.";
const INVALID_MEDIA_ID = "Invalid media_id. Use the attachment.mediaId returned by get_messages.";
const NOT_AUDIO =
  "This media is not audio. transcribe_audio only accepts audio files and voice notes.";
const TOO_LARGE =
  "This audio is larger than MEDIA_MAX_BYTES and cannot be transcribed by this server.";

/** Provider calls running at once within one tool call. */
const DEFAULT_CONCURRENCY = 3;

export type TranscribeResult =
  | { status: "ok"; transcript: string; cached: boolean; durationSeconds?: number }
  /** The message or its file is no longer on WAHA. */
  | { status: "gone" };

export interface TranscriptionService {
  readonly enabled: boolean;
  /**
   * Sets `transcript` on the audio messages given: stored transcripts are always attached;
   * voice notes not yet transcribed are sent to the provider within the limits (duration,
   * NEW transcriptions per call). Failures are not fatal. Returns coverage notes.
   */
  annotate(messages: NormalizedMessage[]): Promise<string[]>;
  /** Attaches stored transcripts only (no provider call). */
  attachStored(messages: NormalizedMessage[]): Promise<void>;
  /**
   * On demand: any audio or voice note up to MEDIA_MAX_BYTES, stored like the automatic ones.
   * Throws `InvalidInputError` (bad id, not audio, too large) or `TranscriptionError`.
   */
  transcribeMedia(mediaId: string, mapper?: EngineMapper): Promise<TranscribeResult>;
}

/** Transcription off: nothing is read, stored or sent anywhere. */
export const DISABLED_TRANSCRIPTION: TranscriptionService = {
  enabled: false,
  annotate: async () => [],
  attachStored: async () => {},
  transcribeMedia: async () => {
    throw new InvalidInputError(TRANSCRIPTION_NOT_CONFIGURED);
  },
};

export interface TranscriptionOptions {
  /** Its `getMe` identifies the account the stored transcripts belong to. */
  gateway: Pick<WahaGateway, "getMe">;
  audio: AudioSource;
  store: TranscriptStore;
  transcriber: Transcriber;
  /** WAHA session name; with `getMe().id` it forms the owner identity (shared with the message cache). */
  session: string;
  /** TRANSCRIPTION_MAX_SECONDS. */
  maxSeconds: number;
  /** TRANSCRIPTION_MAX_PER_CALL (0 = on demand only). */
  maxPerCall: number;
  concurrency?: number;
}

type Key = { chatId: string; messageId: string };

/** The audio file stopped being transcribable before it reached the provider. */
class Unavailable extends Error {
  constructor(readonly reason: "gone" | "not-audio" | "too-large") {
    super(reason);
  }
}

const EXTENSIONS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "audio/amr": "amr",
};

/** Providers detect the format from the file name: WhatsApp voice notes are `voice.ogg`. */
function fileNameFor(mimetype: string): string {
  const base = (mimetype.split(";")[0] ?? "").trim().toLowerCase();
  if (base === "audio/ogg" || base === "audio/opus") return "voice.ogg";
  const ext = EXTENSIONS[base] ?? (base.split("/")[1] ?? "").replace(/[^a-z0-9]/g, "");
  return `audio.${ext || "ogg"}`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Runs `fn` over `items` with at most `size` in flight. */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

const isAudio = (m: NormalizedMessage) =>
  m.attachment !== null &&
  (m.attachment.kind === "audio" || m.attachment.kind === "voice") &&
  m.attachment.mediaId !== null;

interface Group {
  key: Key;
  mediaId: string;
  voice: boolean;
  durationSeconds: number | null;
  timestamp: string;
  messages: NormalizedMessage[];
}

export function createTranscriptionService(o: TranscriptionOptions): TranscriptionService {
  const concurrency = o.concurrency ?? DEFAULT_CONCURRENCY;
  /** Per message: the one provider call in progress, shared by every caller. */
  const inFlight = new Map<string, Promise<string>>();
  const idOf = (k: Key) => `${k.chatId}\n${k.messageId}`;

  let ownerChecked = false;
  let ownerCheck: Promise<boolean> | null = null;
  /**
   * Same rule as the message cache: nothing stored is served or written until the account
   * (session + `getMe().id`) is known; a different account wipes `cache.db` first.
   */
  const ensureOwner = (): Promise<boolean> => {
    if (ownerChecked) return Promise.resolve(true);
    ownerCheck ??= o.gateway
      .getMe()
      .then((me) => {
        const owner = `${o.session}|${me.id}`;
        if (o.store.getOwner() !== owner) o.store.resetForOwner(owner);
        ownerChecked = true;
        return true;
      })
      .catch(() => false)
      .finally(() => {
        ownerCheck = null;
      });
    return ownerCheck;
  };

  /** One provider call per message, stored before anyone sees it; later callers join it. */
  const transcribeOnce = (key: Key, run: () => Promise<string>): Promise<string> => {
    const id = idOf(key);
    const running = inFlight.get(id);
    if (running) return running;
    const p = run()
      .then((text) => {
        o.store.put(key.chatId, key.messageId, text);
        return text;
      })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  };

  /** Loads the audio and sends it to the provider; `onDuration` receives the declared length. */
  const loadAndTranscribe =
    (mediaId: string, mapper?: EngineMapper, onDuration?: (s: number | null) => void) =>
    async (): Promise<string> => {
      const loaded = await o.audio.load(mediaId, mapper);
      if (loaded.status !== "ok") throw new Unavailable(loaded.status);
      onDuration?.(loaded.file.durationSeconds);
      return o.transcriber.transcribe({
        bytes: loaded.file.bytes,
        mimetype: loaded.file.mimetype,
        filename: fileNameFor(loaded.file.mimetype),
      });
    };

  /** Audio messages grouped by chat + message id (a message may appear twice in one answer). */
  function groupAudio(messages: NormalizedMessage[]): Group[] {
    const groups = new Map<string, Group>();
    for (const m of messages) {
      if (!isAudio(m)) continue;
      const attachment = m.attachment as NonNullable<NormalizedMessage["attachment"]>;
      const mediaId = attachment.mediaId as string;
      const key = o.audio.keyOf(mediaId);
      if (!key) continue;
      const id = idOf(key);
      const g = groups.get(id);
      if (g) g.messages.push(m);
      else
        groups.set(id, {
          key,
          mediaId,
          voice: m.type === "voice" && attachment.kind === "voice",
          durationSeconds: attachment.durationSeconds ?? null,
          timestamp: m.timestamp,
          messages: [m],
        });
    }
    return [...groups.values()];
  }

  const setTranscript = (g: Group, text: string) => {
    for (const m of g.messages) m.transcript = text;
  };

  /** Attaches stored transcripts; returns the groups that have none. */
  function attachFromStore(groups: Group[]): Group[] {
    const missing: Group[] = [];
    for (const g of groups) {
      const stored = o.store.get(g.key.chatId, g.key.messageId);
      if (stored === null) missing.push(g);
      else setTranscript(g, stored);
    }
    return missing;
  }

  return {
    enabled: true,

    async attachStored(messages) {
      const groups = groupAudio(messages);
      if (groups.length === 0 || !(await ensureOwner())) return;
      attachFromStore(groups);
    },

    async annotate(messages) {
      const groups = groupAudio(messages);
      if (groups.length === 0) return [];
      if (!(await ensureOwner())) return groups.some((g) => g.voice) ? [OWNER_UNVERIFIED] : [];
      const missing = attachFromStore(groups).filter((g) => g.voice);
      // Already being transcribed by another call: wait for it, it costs nothing more.
      const joined = missing.filter((g) => inFlight.has(idOf(g.key)));
      const rest = missing.filter((g) => !inFlight.has(idOf(g.key)));
      const fits = (g: Group) => g.durationSeconds !== null && g.durationSeconds <= o.maxSeconds;
      const tooLong = rest.filter((g) => !fits(g)).length;
      const eligible = rest
        .filter(fits)
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
      const run = eligible.slice(0, o.maxPerCall);
      const capped = eligible.length - run.length;

      let failed = 0;
      // A rejected key or a rate limit will fail every other call too: stop sending this call.
      let stop = false;
      const attempt = async (g: Group, isNew: boolean) => {
        if (stop && isNew) {
          failed++;
          return;
        }
        try {
          setTranscript(g, await transcribeOnce(g.key, loadAndTranscribe(g.mediaId)));
        } catch (error) {
          failed++;
          if (error instanceof TranscriptionError && error.kind !== "failed") stop = true;
        }
      };
      await Promise.all([
        ...joined.map((g) => attempt(g, false)),
        pool(run, concurrency, (g) => attempt(g, true)),
      ]);

      const notes: string[] = [];
      if (failed > 0)
        notes.push(`${count(failed, "voice note", "voice notes")} could not be transcribed.`);
      if (capped > 0 && o.maxPerCall === 0)
        notes.push(
          "Automatic transcription is off (TRANSCRIPTION_MAX_PER_CALL=0); use transcribe_audio for a specific voice note.",
        );
      else if (capped > 0)
        notes.push(
          `${count(capped, "voice note was", "voice notes were")} not transcribed (limit of ${o.maxPerCall} new transcriptions per call); use transcribe_audio with their media_id.`,
        );
      if (tooLong > 0)
        notes.push(
          `${count(tooLong, "voice note", "voice notes")} longer than ${o.maxSeconds} s (or of unknown length) ${tooLong === 1 ? "was" : "were"} not transcribed automatically; use transcribe_audio with their media_id.`,
        );
      return notes;
    },

    async transcribeMedia(mediaId, mapper) {
      const key = o.audio.keyOf(mediaId);
      if (!key) throw new InvalidInputError(INVALID_MEDIA_ID);
      let durationSeconds: number | null = null;
      const run = loadAndTranscribe(mediaId, mapper, (s) => {
        durationSeconds = s;
      });
      const owned = await ensureOwner();
      if (owned) {
        const stored = o.store.get(key.chatId, key.messageId);
        if (stored !== null) return { status: "ok", transcript: stored, cached: true };
      }
      try {
        // Without a verified account nothing is stored (it could belong to someone else).
        const transcript = owned ? await transcribeOnce(key, run) : await run();
        const seconds = durationSeconds as number | null;
        return {
          status: "ok",
          transcript,
          cached: false,
          ...(seconds === null ? {} : { durationSeconds: seconds }),
        };
      } catch (error) {
        if (!(error instanceof Unavailable)) throw error;
        if (error.reason === "gone") return { status: "gone" };
        throw new InvalidInputError(error.reason === "not-audio" ? NOT_AUDIO : TOO_LARGE);
      }
    },
  };
}
