import { type EmailFailure, EmailSendError } from "../../domain/errors.js";
import type { EmailSender } from "../../domain/ports/EmailSender.js";

/** Cloudflare gets this long to accept one email. */
export const EMAIL_TIMEOUT_MS = 15_000;

export interface CloudflareEmailOptions {
  accountId: string;
  apiToken: string;
  /** Sender, e.g. `Zenbox <hola@usezenbox.com>`; its domain must be onboarded for Email Sending. */
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const kindOf = (status: number): EmailFailure =>
  status === 401 || status === 403
    ? "auth"
    : status === 429
      ? "rateLimited"
      : status === 400
        ? "rejected"
        : "failed";

/**
 * Cloudflare Email Service REST API (`POST /accounts/{id}/email/sending/send`). Redirects are
 * refused so the token never follows one; failures become an `EmailSendError` with a fixed
 * message, so the provider's body, the URL and the token never reach callers or logs.
 */
export function createCloudflareEmailSender(opts: CloudflareEmailOptions): EmailSender {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? EMAIL_TIMEOUT_MS;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(opts.accountId)}/email/sending/send`;
  return {
    async send(email) {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: opts.from,
            to: email.to,
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
      const ok =
        typeof body === "object" && body !== null && (body as { success?: unknown }).success;
      if (ok !== true) throw new EmailSendError("failed", res.status);
    },
  };
}
