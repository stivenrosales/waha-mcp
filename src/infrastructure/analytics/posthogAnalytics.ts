import type { Analytics } from "../../domain/ports/Analytics.js";

/** PostHog gets this long to accept one event. */
export const ANALYTICS_TIMEOUT_MS = 5_000;

export interface PostHogAnalyticsOptions {
  /** Project token (`phc_…`): write-only. */
  apiKey: string;
  /** Ingestion host without a trailing slash, e.g. `https://us.i.posthog.com`. */
  host: string;
  logger: { info(message: string): void };
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** `capture` plus `flush`, which waits for the events in flight (tests and shutdown). */
export interface PostHogAnalytics extends Analytics {
  flush(): Promise<void>;
}

/**
 * Server-side events through PostHog's capture API (`POST {host}/i/v0/e/`). Each event is
 * sent in the background; a failure is logged with the event name only, never thrown.
 */
export function createPostHogAnalytics(opts: PostHogAnalyticsOptions): PostHogAnalytics {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? ANALYTICS_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date());
  const inFlight = new Set<Promise<void>>();

  const send = async (name: string, body: string) => {
    try {
      const res = await doFetch(`${opts.host}/i/v0/e/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch {
      opts.logger.info(`analytics event=${name} not sent`);
    }
  };

  return {
    capture(event) {
      const body = JSON.stringify({
        api_key: opts.apiKey,
        event: event.name,
        distinct_id: event.distinctId,
        properties: { ...event.properties, $lib: "waha-mcp" },
        timestamp: now().toISOString(),
      });
      const p = send(event.name, body).finally(() => inFlight.delete(p));
      inFlight.add(p);
    },
    async flush() {
      await Promise.all(inFlight);
    },
  };
}
