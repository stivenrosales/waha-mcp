export type SessionState =
  | "STOPPED"
  | "STARTING"
  | "SCAN_QR_CODE"
  | "WORKING"
  | "FAILED"
  | "UNKNOWN";

/** Where WAHA delivers a session's events, and the HMAC key it signs them with. */
export interface WebhookTarget {
  url: string;
  /** Never logged. */
  secret: string;
}

/** Administers WAHA sessions (one per tenant). */
export interface SessionAdmin {
  /** Creates the session and starts it, with the missions webhook when one is given. */
  create(name: string, opts?: { webhook?: WebhookTarget }): Promise<void>;
  /** Starts a STOPPED session (it goes to STARTING, then SCAN_QR_CODE). */
  start(name: string): Promise<void>;
  /**
   * Stops and starts a session. Use it for FAILED: WAHA still counts a FAILED session as
   * running, so start() is a no-op there.
   */
  restart(name: string): Promise<void>;
  state(name: string): Promise<SessionState>;
  /** The pairing QR; null unless the session is in SCAN_QR_CODE. */
  qr(name: string): Promise<{ mimetype: string; base64: string } | null>;
  /** The linked WhatsApp account; null when none is linked. */
  me(name: string): Promise<{ id: string } | null>;
  logout(name: string): Promise<void>;
  /** Idempotent: a session that does not exist counts as removed. */
  remove(name: string): Promise<void>;
  /**
   * Makes `target` one of the session's webhooks (`message.any` and `session.status`): any other
   * webhook with the same url is replaced, every other webhook and setting is kept. Idempotent:
   * when the session already has exactly this webhook nothing is written, because WAHA restarts
   * a running session whenever its config is replaced. Throws when the session does not exist.
   */
  configureWebhook(name: string, target: WebhookTarget): Promise<void>;
}
