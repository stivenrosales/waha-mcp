import { WahaAuthError, WahaNotFoundError, WahaUnavailableError } from "../../domain/errors.js";
import type { WahaGateway } from "../../domain/ports/WahaGateway.js";

export interface WahaHttpGatewayOptions {
  baseUrl: string;
  apiKey: string;
  session: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// Listing ~260 groups was measured at ~5 s on GOWS, so keep generous headroom.
const DEFAULT_TIMEOUT_MS = 15_000;
const MEDIA_PATH_PREFIX = "/api/files/";

/**
 * Read-only WAHA client: GET requests only. Errors are mapped to domain errors
 * with fixed messages so neither the API key nor the base URL can leak.
 */
export function createWahaHttpGateway(opts: WahaHttpGatewayOptions): WahaGateway {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const session = encodeURIComponent(opts.session);

  /**
   * `headersOnly`: the timeout stops once the headers arrive, so a large body can
   * stream for longer (used for media). Otherwise it also covers reading the body.
   */
  async function get(pathAndQuery: string, o: { headersOnly?: boolean } = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const signal = controller.signal;
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new WahaUnavailableError("WAHA request timed out.")),
        {
          once: true,
        },
      );
    });
    aborted.catch(() => {});
    let res: Response;
    try {
      res = await Promise.race([
        doFetch(`${baseUrl}${pathAndQuery}`, {
          method: "GET",
          // Never follow redirects: they could resend X-Api-Key to another origin.
          redirect: "error",
          headers: { "X-Api-Key": opts.apiKey },
          signal,
        }),
        aborted,
      ]);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof WahaUnavailableError) throw err;
      throw new WahaUnavailableError("Could not reach WAHA.");
    }
    if (o.headersOnly) clearTimeout(timer);
    return res;
  }

  /** Maps non-2xx statuses. 404/410 are returned to the caller via `allowGone`. */
  function assertOk(res: Response, what: string): void {
    if (res.ok) return;
    if (res.status === 401 || res.status === 403) throw new WahaAuthError();
    if (res.status === 404) throw new WahaNotFoundError(what);
    throw new WahaUnavailableError(`WAHA responded with status ${res.status}.`);
  }

  async function getJson(pathAndQuery: string, what: string): Promise<unknown> {
    const res = await get(pathAndQuery);
    assertOk(res, what);
    try {
      return await res.json();
    } catch {
      throw new WahaUnavailableError("WAHA returned an invalid response body.");
    }
  }

  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

  return {
    async getSession() {
      const body = (await getJson(`/api/sessions/${session}`, "session")) as {
        engine?: { engine?: unknown };
        status?: unknown;
      } | null;
      return {
        engine: typeof body?.engine?.engine === "string" ? body.engine.engine : "unknown",
        status: typeof body?.status === "string" ? body.status : "unknown",
      };
    },

    async listGroups() {
      return asArray(await getJson(`/api/${session}/groups`, "groups"));
    },

    async getGroup(groupId) {
      return getJson(`/api/${session}/groups/${encodeURIComponent(groupId)}`, "group");
    },

    async listChats(q) {
      const params = new URLSearchParams({ limit: String(q.limit), offset: String(q.offset) });
      return asArray(await getJson(`/api/${session}/chats?${params}`, "chats"));
    },

    async listContacts(q) {
      const params = new URLSearchParams({
        session: opts.session,
        limit: String(q.limit),
        offset: String(q.offset),
      });
      return asArray(await getJson(`/api/contacts/all?${params}`, "contacts"));
    },

    async getMessages(chatId, q) {
      const params = new URLSearchParams({
        limit: String(q.limit),
        offset: String(q.offset),
        downloadMedia: "false",
      });
      if (q.from !== undefined) params.set("filter.timestamp.gte", String(q.from));
      if (q.to !== undefined) params.set("filter.timestamp.lte", String(q.to));
      const path = `/api/${session}/chats/${encodeURIComponent(chatId)}/messages?${params}`;
      return asArray(await getJson(path, "chat"));
    },

    async getMessage(chatId, messageId) {
      const path = `/api/${session}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?downloadMedia=true`;
      return getJson(path, "message");
    },

    async openMedia(url) {
      let parsed: URL;
      try {
        parsed = new URL(url, baseUrl);
      } catch {
        throw new WahaNotFoundError("media");
      }
      // Only the path matters: WAHA may advertise its own (internal) host, and
      // always fetching from baseUrl also rules out SSRF through foreign hosts.
      if (!parsed.pathname.startsWith(MEDIA_PATH_PREFIX)) throw new WahaNotFoundError("media");
      const res = await get(`${parsed.pathname}${parsed.search}`, { headersOnly: true });
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      if (!res.ok) await res.body?.cancel().catch(() => {});
      assertOk(res, "media");
      const declared = res.headers.get("content-length");
      const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
      return {
        body: res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        mimetype:
          res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
        length: length !== null && Number.isSafeInteger(length) ? length : null,
      };
    },
  };
}
