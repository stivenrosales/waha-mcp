import type { PolarStatus, PolarSubscription } from "../../application/polarSync.js";

// Statuses Polar adds later pass through: the sync ignores what it does not know.

const TIMEOUT_MS = 5_000;

/** Fixed messages: the token, the URL and Polar's body never reach callers or logs. */
export class PolarApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarApiError";
  }
}

export interface PolarClient {
  getSubscription(id: string): Promise<PolarSubscription>;
}

/** `GET {apiUrl}/v1/subscriptions/{id}` with an organization access token (`subscriptions:read`). */
export function createPolarClient(opts: {
  apiUrl: string;
  accessToken: string;
  fetch?: typeof fetch;
}): PolarClient {
  const doFetch = opts.fetch ?? fetch;
  return {
    async getSubscription(id) {
      let res: Response;
      try {
        res = await doFetch(`${opts.apiUrl}/v1/subscriptions/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${opts.accessToken}`, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new PolarApiError("Polar API request failed (no response).");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new PolarApiError(`Polar API request failed (status ${res.status}).`);
      }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const customer = (body?.customer ?? {}) as Record<string, unknown>;
      if (
        typeof body?.id !== "string" ||
        typeof body.status !== "string" ||
        typeof body.customer_id !== "string" ||
        typeof customer.email !== "string"
      )
        throw new PolarApiError("Polar API returned an unexpected subscription.");
      return {
        id: body.id,
        status: body.status as PolarStatus,
        customerId: body.customer_id,
        customerEmail: customer.email,
      };
    },
  };
}
