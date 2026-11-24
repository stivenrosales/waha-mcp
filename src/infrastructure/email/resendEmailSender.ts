import { type EmailFailure, EmailSendError } from "../../domain/errors.js";
import type { EmailSender } from "../../domain/ports/EmailSender.js";

/** Resend gets this long to accept one email. */
export const EMAIL_TIMEOUT_MS = 15_000;

export interface ResendEmailOptions {
  apiKey: string;
  /** Sender, e.g. `Zenbox <hola@usezenbox.com>`; its domain must be verified in Resend. */
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const kindOf = (status: number): EmailFailure =>
  status === 401 || status === 403
    ? "auth"
    : status === 429
      ? "rateLimited"
      : status === 400 || status === 422
        ? "rejected"
        : "failed";

/**
 * Resend's REST API (`POST https://api.resend.com/emails`). Redirects are refused so the key
 * never follows one; failures become an `EmailSendError` with a fixed message, so Resend's
 * body, the URL and the key never reach callers or logs.
 */
export function createResendEmailSender(opts: ResendEmailOptions): EmailSender {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? EMAIL_TIMEOUT_MS;
  return {
    async send(email) {
      let res: Response;
      try {
        res = await doFetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: opts.from,
            to: [email.to],
            subject: email.subject,
            text: email.text,
            ...(email.html ? { html: email.html } : {}),
          }),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new EmailSendError("failed");
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) throw new EmailSendError(kindOf(res.status), res.status);
      const id = typeof body === "object" && body !== null ? (body as { id?: unknown }).id : null;
      if (typeof id !== "string") throw new EmailSendError("failed", res.status);
    },
  };
}
