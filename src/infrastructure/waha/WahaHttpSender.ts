import {
  InvalidInputError,
  MediaSendUnsupportedError,
  SendOutcomeUnknownError,
  WahaAuthError,
  WahaNotFoundError,
  WahaUnavailableError,
  WhatsAppDisconnectedError,
} from "../../domain/errors.js";
import type { FileSource, SentMessage, WhatsAppSender } from "../../domain/ports/WhatsAppSender.js";
import { isSessionNotWorking } from "./sessionState.js";

export interface WahaHttpSenderOptions {
  baseUrl: string;
  apiKey: string;
  session: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// Media goes up as base64 in the body, so allow for slow uploads.
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_REASON_CHARS = 200;
/** Connection errors that happen before any byte of the request leaves the server. */
const NEVER_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

type Json = Record<string, unknown>;

const asRecord = (v: unknown): Json =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};

const defined = (o: Json): Json =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function filePayload(file: FileSource): Json {
  return "url" in file
    ? { mimetype: file.mimetype, filename: file.filename, url: file.url }
    : {
        mimetype: file.mimetype,
        filename: file.filename,
        data: Buffer.from(file.data).toString("base64"),
      };
}

/**
 * WAHA client for the send endpoints: POST only, never follows redirects, and errors
 * carry fixed or scrubbed messages so neither the API key nor the base URL can leak.
 */
export function createWahaHttpSender(opts: WahaHttpSenderOptions): WhatsAppSender {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const scrub = (text: string): string =>
    text.split(opts.apiKey).join("***").split(baseUrl).join("WAHA").slice(0, MAX_REASON_CHARS);

  async function post(path: string, body: Json, media: boolean): Promise<SentMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let res: Response;
    let text: string;
    try {
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(new SendOutcomeUnknownError()), {
          once: true,
        }),
      );
      aborted.catch(() => {});
      res = await Promise.race([
        doFetch(`${baseUrl}${path}`, {
          method: "POST",
          redirect: "error",
          headers: { "X-Api-Key": opts.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify(defined({ session: opts.session, ...body })),
          signal: controller.signal,
        }),
        aborted,
      ]);
      text = await Promise.race([res.text(), aborted]);
    } catch (err) {
      // No connection at all: nothing reached WAHA, so this is a plain failure.
      const code = asRecord(asRecord(err).cause).code;
      if (typeof code === "string" && NEVER_SENT.has(code))
        throw new WahaUnavailableError("Could not reach WAHA; nothing was sent.");
      // Otherwise the request may have reached WAHA: the outcome is unknown.
      throw new SendOutcomeUnknownError();
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    const reason = (() => {
      const m = asRecord(parsed).message;
      return typeof m === "string" ? m : Array.isArray(m) ? m.join("; ") : "";
    })();

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new WahaAuthError();
      // Checked before the generic 422 "rejected": an unpaired session is not a bad message.
      if (isSessionNotWorking(res.status, parsed)) throw new WhatsAppDisconnectedError();
      if (media && (res.status === 501 || /\bplus\b/i.test(reason)))
        throw new MediaSendUnsupportedError();
      if (res.status === 404) throw new WahaNotFoundError("chat");
      if (res.status === 400 || res.status === 422)
        throw new InvalidInputError(
          reason ? `WAHA rejected the message: ${scrub(reason)}` : "WAHA rejected the message.",
        );
      throw new WahaUnavailableError(`WAHA responded with status ${res.status}.`);
    }

    const o = asRecord(parsed);
    const rawId = typeof o.id === "string" ? o.id : asRecord(o.id)._serialized;
    const ts = o.timestamp;
    return {
      id: typeof rawId === "string" ? rawId : "",
      timestamp: typeof ts === "number" && Number.isFinite(ts) ? ts : null,
    };
  }

  return {
    sendText: (q) =>
      post(
        "/api/sendText",
        { chatId: q.chatId, text: q.text, reply_to: q.replyTo, mentions: q.mentions },
        false,
      ),
    sendImage: (q) =>
      post(
        "/api/sendImage",
        { chatId: q.chatId, caption: q.caption, reply_to: q.replyTo, file: filePayload(q.file) },
        true,
      ),
    sendFile: (q) =>
      post(
        "/api/sendFile",
        { chatId: q.chatId, caption: q.caption, reply_to: q.replyTo, file: filePayload(q.file) },
        true,
      ),
    sendVideo: (q) =>
      post(
        "/api/sendVideo",
        {
          chatId: q.chatId,
          caption: q.caption,
          reply_to: q.replyTo,
          file: filePayload(q.file),
          convert: true,
        },
        true,
      ),
    sendVoice: (q) =>
      post(
        "/api/sendVoice",
        { chatId: q.chatId, reply_to: q.replyTo, file: filePayload(q.file), convert: true },
        true,
      ),
    sendLocation: (q) =>
      post(
        "/api/sendLocation",
        {
          chatId: q.chatId,
          latitude: q.latitude,
          longitude: q.longitude,
          title: q.title,
          reply_to: q.replyTo,
        },
        false,
      ),
    sendContact: (q) =>
      post(
        "/api/sendContactVcard",
        {
          chatId: q.chatId,
          reply_to: q.replyTo,
          contacts: [
            defined({
              fullName: q.fullName,
              organization: q.organization,
              phoneNumber: q.phoneNumber,
              whatsappId: q.phoneNumber.replace(/\D/g, ""),
            }),
          ],
        },
        false,
      ),
  };
}
