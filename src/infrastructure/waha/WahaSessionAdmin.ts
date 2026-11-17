import { WahaAuthError, WahaUnavailableError } from "../../domain/errors.js";
import type { SessionAdmin, SessionState, WebhookTarget } from "../../domain/ports/SessionAdmin.js";

export interface WahaSessionAdminOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const KNOWN_STATES: readonly SessionState[] = [
  "STOPPED",
  "STARTING",
  "SCAN_QR_CODE",
  "WORKING",
  "FAILED",
];

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/** Missions only consume these: `message.any` already carries incoming messages (spike §3.8). */
const WEBHOOK_EVENTS = ["message.any", "session.status"] as const;
/**
 * WAHA's own defaults (spike §2.6), made explicit so the stored config is self-describing:
 * a constant 2 s delay, 15 attempts (~30 s), which covers a server restart or deploy.
 */
const WEBHOOK_RETRIES = { policy: "constant", delaySeconds: 2, attempts: 15 } as const;

/** The session-config webhook entry WAHA expects (spike §2.1). */
const webhookEntry = (target: WebhookTarget) => ({
  url: target.url,
  events: [...WEBHOOK_EVENTS],
  hmac: { key: target.secret },
  retries: { ...WEBHOOK_RETRIES },
  customHeaders: null,
});

/** Whether WAHA's echo of a webhook entry says the same thing as ours (extra defaults ignored). */
function sameWebhook(current: unknown, target: WebhookTarget): boolean {
  const c = asRecord(current);
  const events = Array.isArray(c.events) ? [...c.events].map(String).sort() : [];
  const retries = asRecord(c.retries);
  return (
    c.url === target.url &&
    events.join(",") === [...WEBHOOK_EVENTS].sort().join(",") &&
    asRecord(c.hmac).key === target.secret &&
    retries.policy === WEBHOOK_RETRIES.policy &&
    retries.delaySeconds === WEBHOOK_RETRIES.delaySeconds &&
    retries.attempts === WEBHOOK_RETRIES.attempts
  );
}

/**
 * WAHA session administration client (create, status, QR, me, logout, delete).
 * Errors map to domain errors with fixed messages: neither the API key nor the base URL leaks.
 */
export function createWahaSessionAdmin(opts: WahaSessionAdminOptions): SessionAdmin {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const sessionPath = (name: string) => `/api/sessions/${encodeURIComponent(name)}`;

  /** One request; the timeout also covers reading the body. Non-2xx responses are returned as-is. */
  async function call(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; ok: boolean; data: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const headers: Record<string, string> = {
      "X-Api-Key": opts.apiKey,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
    aborted.catch(() => {});
    const work = async () => {
      const res = await doFetch(`${baseUrl}${path}`, {
        method,
        // Never follow redirects: they could resend X-Api-Key to another origin.
        redirect: "error",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      let data: unknown = null;
      if (res.ok) {
        const text = await res.text();
        try {
          data = text === "" ? null : (JSON.parse(text) as unknown);
        } catch {
          data = null;
        }
      } else {
        await res.body?.cancel().catch(() => {});
      }
      return { status: res.status, ok: res.ok, data };
    };
    try {
      // Race against the abort so a fetch that ignores the signal still times out.
      return await Promise.race([work(), aborted]);
    } catch {
      if (controller.signal.aborted) throw new WahaUnavailableError("WAHA request timed out.");
      throw new WahaUnavailableError("Could not reach WAHA.");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Throws for failures; statuses in `tolerated` are returned to the caller instead. */
  async function request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    o: { body?: unknown; tolerate?: number[] } = {},
  ) {
    const res = await call(method, path, o.body);
    if (res.ok || o.tolerate?.includes(res.status)) return res;
    if (res.status === 401 || res.status === 403) throw new WahaAuthError();
    throw new WahaUnavailableError(`WAHA responded with status ${res.status}.`);
  }

  async function state(name: string): Promise<SessionState> {
    const res = await request("GET", sessionPath(name), { tolerate: [404] });
    const status = asRecord(res.data).status;
    return KNOWN_STATES.find((s) => s === status) ?? "UNKNOWN";
  }

  return {
    async create(name, opts) {
      const config = opts?.webhook ? { config: { webhooks: [webhookEntry(opts.webhook)] } } : {};
      await request("POST", "/api/sessions", { body: { name, start: true, ...config } });
    },
    async start(name) {
      await request("POST", `${sessionPath(name)}/start`);
    },
    async restart(name) {
      await request("POST", `${sessionPath(name)}/restart`);
    },
    state,
    async qr(name) {
      if ((await state(name)) !== "SCAN_QR_CODE") return null;
      const res = await request("GET", `/api/${encodeURIComponent(name)}/auth/qr?format=image`, {
        tolerate: [404, 422],
      });
      const { mimetype, data } = asRecord(res.data);
      if (!res.ok || typeof mimetype !== "string" || typeof data !== "string") return null;
      return { mimetype, base64: data };
    },
    async me(name) {
      const res = await request("GET", `${sessionPath(name)}/me`, { tolerate: [404] });
      const id = asRecord(res.data).id;
      return typeof id === "string" && id !== "" ? { id } : null;
    },
    async logout(name) {
      await request("POST", `${sessionPath(name)}/logout`);
    },
    async remove(name) {
      await request("DELETE", sessionPath(name), { tolerate: [404] });
    },
    async configureWebhook(name, target) {
      const res = await request("GET", sessionPath(name), { tolerate: [404] });
      if (!res.ok) throw new WahaUnavailableError("WAHA session not found.");
      const config = asRecord(asRecord(res.data).config);
      const current = Array.isArray(config.webhooks) ? (config.webhooks as unknown[]) : [];
      const ours = current.filter((w) => asRecord(w).url === target.url);
      if (ours.length === 1 && sameWebhook(ours[0], target)) return;
      // PUT replaces the whole config and restarts a running session (spike §2.2), so write
      // only when something changed, and keep every other webhook and setting as it was.
      const others = current.filter((w) => asRecord(w).url !== target.url);
      await request("PUT", sessionPath(name), {
        body: { name, config: { ...config, webhooks: [...others, webhookEntry(target)] } },
      });
    },
  };
}
