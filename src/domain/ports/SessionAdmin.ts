export type SessionState =
  | "STOPPED"
  | "STARTING"
  | "SCAN_QR_CODE"
  | "WORKING"
  | "FAILED"
  | "UNKNOWN";

/** Administers WAHA sessions (one per tenant). */
export interface SessionAdmin {
  /** Creates the session and starts it. */
  create(name: string): Promise<void>;
  /** Starts a STOPPED or FAILED session again (it goes back to STARTING, then SCAN_QR_CODE). */
  start(name: string): Promise<void>;
  state(name: string): Promise<SessionState>;
  /** The pairing QR; null unless the session is in SCAN_QR_CODE. */
  qr(name: string): Promise<{ mimetype: string; base64: string } | null>;
  /** The linked WhatsApp account; null when none is linked. */
  me(name: string): Promise<{ id: string } | null>;
  logout(name: string): Promise<void>;
  /** Idempotent: a session that does not exist counts as removed. */
  remove(name: string): Promise<void>;
}
