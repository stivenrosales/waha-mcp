import { describe, expect, it } from "vitest";
import { createPostHogAnalytics } from "../../../src/infrastructure/analytics/posthogAnalytics.js";

const event = {
  name: "subscription_started",
  distinctId: "tenant_1",
  properties: { status: "active", returning_customer: false },
};

describe("PostHog analytics", () => {
  it("posts the event to the capture endpoint with the project key", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const logs: string[] = [];
    const analytics = createPostHogAnalytics({
      apiKey: "phc_test",
      host: "https://us.i.posthog.com",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: 200 });
      },
      logger: { info: (m) => void logs.push(m) },
      now: () => new Date("2026-11-24T00:00:00.000Z"),
    });
    analytics.capture(event);
    await analytics.flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://us.i.posthog.com/i/v0/e/");
    expect(requests[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      api_key: "phc_test",
      event: "subscription_started",
      distinct_id: "tenant_1",
      properties: { status: "active", returning_customer: false, $lib: "waha-mcp" },
      timestamp: "2026-11-24T00:00:00.000Z",
    });
    expect(logs).toEqual([]);
  });

  it("never throws when PostHog fails or is unreachable, and logs without the key", async () => {
    for (const fail of [
      async () => new Response("nope", { status: 500 }),
      async () => {
        throw new TypeError("network down");
      },
    ]) {
      const logs: string[] = [];
      const analytics = createPostHogAnalytics({
        apiKey: "phc_secret",
        host: "https://us.i.posthog.com",
        fetch: fail,
        logger: { info: (m) => void logs.push(m) },
      });
      expect(() => analytics.capture(event)).not.toThrow();
      await analytics.flush();
      expect(logs).toEqual(["analytics event=subscription_started not sent"]);
      expect(logs.join()).not.toContain("phc_secret");
    }
  });
});
