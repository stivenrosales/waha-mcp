import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type PolarSync, ProvisionCapError } from "../../application/polarSync.js";
import type { PolarStore } from "../../domain/ports/PolarStore.js";
import { verifyStandardWebhook } from "./standardWebhooks.js";

const MAX_BODY_BYTES = 1024 * 1024;
/** Handled delivery ids are kept this long; Polar's retries end well before. */
const KEEP_DELIVERIES_MS = 7 * 86_400_000;

/**
 * `POST /webhooks/polar`: verifies the Standard Webhooks signature, skips deliveries already
 * handled, and applies `subscription.*` events one at a time. 202 = handled (or ignored);
 * 403 = bad signature; 429 = new-account cap reached; 500 = failed. Polar redelivers non-2xx.
 */
export function createPolarWebhookRoute(deps: {
  secret: string;
  store: PolarStore;
  sync: PolarSync;
  logger: { info(message: string): void };
  now?: () => number;
}): Hono {
  const now = deps.now ?? Date.now;
  const app = new Hono();
  let queue: Promise<unknown> = Promise.resolve();
  /** Runs `fn` after every earlier delivery, so one subscription is never provisioned twice. */
  const serially = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  app.post(
    "/webhooks/polar",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.text("Payload too large", 413) }),
    async (c) => {
      const body = await c.req.text();
      const webhookId = c.req.header("webhook-id");
      const ok = verifyStandardWebhook(
        deps.secret,
        {
          id: webhookId,
          timestamp: c.req.header("webhook-timestamp"),
          signature: c.req.header("webhook-signature"),
        },
        body,
        now(),
      );
      if (!ok || !webhookId) return c.text("Invalid signature", 403);

      let event: { type?: unknown; data?: { id?: unknown } } | null = null;
      try {
        event = JSON.parse(body);
      } catch {
        event = null;
      }
      const type = typeof event?.type === "string" ? event.type : "";
      const subscriptionId = typeof event?.data?.id === "string" ? event.data.id : null;

      return serially(async () => {
        if (deps.store.isProcessed(webhookId)) return c.body(null, 202);
        if (!type.startsWith("subscription.") || !subscriptionId) {
          deps.store.markProcessed(webhookId, now());
          return c.body(null, 202);
        }
        try {
          await deps.sync.handle(subscriptionId);
        } catch (error) {
          if (error instanceof ProvisionCapError) {
            deps.logger.info(`polar webhook type=${type} outcome=capped`);
            return c.text("Too many new accounts; retry later", 429);
          }
          deps.logger.info(`polar webhook type=${type} outcome=failed`);
          return c.text("Failed", 500);
        }
        deps.store.markProcessed(webhookId, now());
        deps.store.pruneProcessed(now() - KEEP_DELIVERIES_MS);
        return c.body(null, 202);
      });
    },
  );
  return app;
}
