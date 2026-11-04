/** Domain errors. Messages never contain the API key or the WAHA base URL. */

export class WahaAuthError extends Error {
  constructor() {
    super("WAHA rejected the credentials (401/403). Check WAHA_API_KEY.");
    this.name = "WahaAuthError";
  }
}

export class WahaNotFoundError extends Error {
  constructor(what = "resource") {
    super(`WAHA ${what} not found.`);
    this.name = "WahaNotFoundError";
  }
}

export class WahaUnavailableError extends Error {
  constructor(reason = "WAHA is unavailable.") {
    super(reason);
    this.name = "WahaUnavailableError";
  }
}

/** WAHA started sending a file and then stopped (no data within the idle timeout). */
export class MediaStalledError extends WahaUnavailableError {
  constructor() {
    super("WAHA did not finish sending the file. Try again later.");
    this.name = "MediaStalledError";
  }
}

export class UnsupportedEngineError extends Error {
  constructor(public readonly engine: string) {
    super(`Unsupported WAHA engine "${engine}". Only GOWS is supported.`);
    this.name = "UnsupportedEngineError";
  }
}

/** The caller supplied an invalid argument (bad range, cursor, timezone...). Message is safe to show. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

/** Fixed, user-facing messages of the transcription provider failures (never the key or the URL). */
export const TRANSCRIPTION_MESSAGES = {
  auth: "The transcription provider rejected the API key — check TRANSCRIPTION_API_KEY.",
  rateLimited: "The transcription provider is rate-limiting requests. Try again later.",
  config:
    "The transcription provider rejected the request — check TRANSCRIPTION_API_URL and TRANSCRIPTION_MODEL.",
  failed: "The transcription provider could not transcribe this audio. Try again later.",
} as const;

export type TranscriptionFailure = keyof typeof TRANSCRIPTION_MESSAGES;

/**
 * The speech-to-text provider failed; `kind` picks one of the fixed messages. `status` is the
 * provider's HTTP status (null when no response arrived), for the server log only.
 */
export class TranscriptionError extends Error {
  constructor(
    public readonly kind: TranscriptionFailure,
    public readonly status: number | null = null,
  ) {
    super(TRANSCRIPTION_MESSAGES[kind]);
    this.name = "TranscriptionError";
  }
}

/** A send request left the server but WAHA never confirmed it: the message may or may not exist. */
export class SendOutcomeUnknownError extends Error {
  constructor() {
    super(
      "WAHA did not confirm the send in time. The message may or may not have been sent: check the chat with get_messages before retrying.",
    );
    this.name = "SendOutcomeUnknownError";
  }
}

/** The connected WAHA build cannot send media (Core before 2026.6.1). */
export class MediaSendUnsupportedError extends Error {
  constructor() {
    super("This WAHA does not support sending media; update to 2026.6.1 or later.");
    this.name = "MediaSendUnsupportedError";
  }
}

/**
 * WAHA answered that the tenant's session is not `WORKING` (unpaired, QR pending, stopped).
 * The tool layer turns it into a "re-pair at <PUBLIC_BASE_URL>/pair" message.
 */
export class WhatsAppDisconnectedError extends Error {
  constructor() {
    super("WhatsApp is disconnected for this account.");
    this.name = "WhatsAppDisconnectedError";
  }
}
