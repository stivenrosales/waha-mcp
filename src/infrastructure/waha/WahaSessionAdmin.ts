import { WahaAuthError, WahaUnavailableError } from "../../domain/errors.js";
import type { SessionAdmin, SessionState } from "../../domain/ports/SessionAdmin.js";

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
    method: "GET" | "POST" | "DELETE",
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
    try {
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
    } catch (err) {
      if (controller.signal.aborted) throw new WahaUnavailableError("WAHA request timed out.");
      if (err instanceof WahaUnavailableError) throw err;
      throw new WahaUnavailableError("Could not reach WAHA.");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Throws for failures; statuses in `tolerated` are returned to the caller instead. */
  async function request(
    method: "GET" | "POST" | "DELETE",
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
    async create(name) {
      await request("POST", "/api/sessions", { body: { name, start: true } });
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
  };
}
