import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { EventStore, WebhookEventKind } from "../../domain/ports/EventStore.js";
import type { SessionAdmin, WebhookTarget } from "../../domain/ports/SessionAdmin.js";
import type { Tenant, TenantStore } from "../../domain/ports/TenantStore.js";
import type { TenantCipher } from "../crypto/envelope.js";
import type { Logger } from "../mcp/defineTool.js";

export const WEBHOOK_PATH = "/webhooks/waha";

/**
 * Message events carry text and media metadata only (WAHA hands media out as a URL), a few KB in
 * practice; 256 KB leaves room for long texts, vCards and `_data` without accepting megabytes.
 */
export const DEFAULT_MAX_WEBHOOK_BYTES = 256 * 1024;

/**
 * Freshness window on the signed envelope `timestamp` (ms): replays and clock skew. It covers
 * WAHA's last exponential retry (~34-41 min, see `WahaSessionAdmin`); a replay inside it is
 * dropped by the event id dedupe.
 */
const MAX_AGE_MS = 45 * 60_000;
const MAX_FUTURE_MS = 2 * 60_000;
/** WAHA ids are `evt_` + a ULID; anything far longer is not one. */
const MAX_EVENT_ID_LENGTH = 128;

const KINDS: Record<string, WebhookEventKind> = {
  "message.any": "message",
  "session.status": "session.status",
  "message.edited": "message.edited",
  "message.revoked": "message.revoked",
  "message.reaction": "message.reaction",
  "poll.vote": "poll.vote",
  "poll.vote.failed": "poll.vote.failed",
};

/** Every 2xx is the same body: the response never tells a stored event from an ignored one. */
const ACK = { ok: true } as const;

export interface WahaWebhookDeps {
  /** `WAHA_WEBHOOK_SECRET`; never logged. */
  secret: string;
  tenants: Pick<TenantStore, "getTenantBySession">;
  /** Only active tenants resolve to a runtime (its cipher seals the payload). */
  registry: {
    acquire(tenantId: string): { runtime: { cipher: TenantCipher }; release(): void } | null;
  };
  events: EventStore;
  /** The kinds this server uses; any other accepted WAHA event is ignored (`reason=event`). */
  kinds: ReadonlySet<WebhookEventKind>;
  logger: Logger;
  /** Wakes the mission engine; fire-and-forget, its failures are logged and swallowed. */
  onEvent?: (e: { tenantId: string; kind: WebhookEventKind }) => void | Promise<void>;
  /** Clock in ms (injectable for tests). */
  now?: () => number;
  maxBodyBytes?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** HMAC-SHA512 of the raw body, hex, compared in constant time (spike §3.9). */
function validSignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(createHmac("sha512", secret).update(body).digest("hex"), "utf8");
  const given = Buffer.from(header.trim().toLowerCase(), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * `POST /webhooks/waha`: WAHA's signed session events, stored sealed for the mission engine.
 *
 * - Missing or bad signature: 401, nothing stored (only a misconfigured secret gets here, and
 *   WAHA's retries make it visible; a forger never gets a 2xx).
 * - Body over the limit: 413.
 * - Everything else answers 200 with the same body, stored or not: unknown session, inactive
 *   tenant, `metadata.tenant` naming another tenant, an event this server does not use, a stale or
 *   future `timestamp`, or a malformed envelope. WAHA retries every non-2xx, so these must not
 *   fail, and a uniform answer leaks nothing about which sessions exist.
 * - Events of the configured `kinds` (`message.any`, `session.status`, edits, revokes, reactions
 *   and poll votes) are sealed with the tenant cipher (AAD
 *   `webhook:<tenantId>:<eventId>`) and stored once per envelope `id`; a first store wakes the
 *   engine without waiting for it.
 *
 * Logs name the tenant, kind and outcome only: never bodies, signatures or the secret.
 */
export function createWahaWebhookRoute(deps: WahaWebhookDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const log = deps.logger;

  const wake = (tenantId: string, kind: WebhookEventKind): void => {
    if (!deps.onEvent) return;
    const failed = (): void => log.info(`webhook tenant=${tenantId} kind=${kind} wake=failed`);
    try {
      const result = deps.onEvent({ tenantId, kind });
      if (result instanceof Promise) result.catch(failed);
    } catch {
      failed();
    }
  };

  /** Stores the event if it is one of the configured kinds; returns the log outcome. */
  const ingest = (raw: Uint8Array): string => {
    let envelope: unknown;
    try {
      envelope = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return "ignored reason=malformed";
    }
    if (!isRecord(envelope)) return "ignored reason=malformed";
    const { id, event, session, timestamp, metadata } = envelope;
    const kind = typeof event === "string" ? KINDS[event] : undefined;
    if (!kind || !deps.kinds.has(kind)) return "ignored reason=event";
    if (
      typeof id !== "string" ||
      id === "" ||
      id.length > MAX_EVENT_ID_LENGTH ||
      typeof session !== "string"
    )
      return "ignored reason=malformed";
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp))
      return "ignored reason=malformed";
    const at = now();
    if (timestamp < at - MAX_AGE_MS || timestamp > at + MAX_FUTURE_MS)
      return "ignored reason=stale";

    const tenant: Tenant | null = deps.tenants.getTenantBySession(session);
    if (tenant?.status !== "active") return "ignored reason=session";
    const claimed = isRecord(metadata) ? metadata.tenant : undefined;
    if (claimed !== undefined && claimed !== tenant.id)
      return `ignored tenant=${tenant.id} reason=tenant-mismatch`;

    const held = deps.registry.acquire(tenant.id);
    if (!held) return `ignored tenant=${tenant.id} reason=unavailable`;
    let sealed: string;
    try {
      sealed = held.runtime.cipher.sealText(
        Buffer.from(raw).toString("utf8"),
        `webhook:${tenant.id}:${id}`,
      );
    } finally {
      held.release();
    }
    const result = deps.events.put({
      tenantId: tenant.id,
      eventId: id,
      kind,
      receivedAt: new Date(at).toISOString(),
      payloadSealed: sealed,
    });
    if (result === "stored") wake(tenant.id, kind);
    return `${result} tenant=${tenant.id} kind=${kind}`;
  };

  app.post(
    WEBHOOK_PATH,
    bodyLimit({
      maxSize: deps.maxBodyBytes ?? DEFAULT_MAX_WEBHOOK_BYTES,
      onError: (c) => {
        log.info("webhook rejected reason=too-large");
        return c.text("Request body too large.", 413);
      },
    }),
    async (c) => {
      const raw = new Uint8Array(await c.req.arrayBuffer());
      if (!validSignature(deps.secret, raw, c.req.header("x-webhook-hmac"))) {
        log.info("webhook rejected reason=signature");
        return c.text("Unauthorized", 401);
      }
      log.info(`webhook ${ingest(raw)}`);
      return c.json(ACK, 200);
    },
  );

  return app;
}

/**
 * Points every active tenant's WAHA session at the webhook route, one tenant at a time. Best
 * effort: a failing tenant is logged (by id only; error texts may carry WAHA details) and the
 * rest go on; it never throws, so it cannot stop the server from booting.
 */
export async function configureTenantWebhooks(deps: {
  tenants: Pick<TenantStore, "listTenants">;
  sessions: Pick<SessionAdmin, "configureWebhook">;
  target: WebhookTarget;
  logger: Logger;
}): Promise<void> {
  let tenants: Tenant[];
  try {
    tenants = deps.tenants.listTenants().filter((t) => t.status === "active");
  } catch {
    deps.logger.info("webhook configure failed reason=tenant-list");
    return;
  }
  for (const tenant of tenants) {
    try {
      await deps.sessions.configureWebhook(tenant.wahaSession, deps.target);
      deps.logger.info(`webhook configure tenant=${tenant.id} outcome=ok`);
    } catch {
      deps.logger.info(`webhook configure tenant=${tenant.id} outcome=failed`);
    }
  }
}
