import { describe, expect, it } from "vitest";
import { WahaAuthError, WahaUnavailableError } from "../../../src/domain/errors.js";
import { createWahaSessionAdmin } from "../../../src/infrastructure/waha/WahaSessionAdmin.js";

const BASE = "http://waha-internal:3000";
const KEY = "k-secret";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(respond: (r: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const rec: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(rec);
    return respond(rec);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const make = (f: typeof fetch) =>
  createWahaSessionAdmin({ baseUrl: `${BASE}/`, apiKey: KEY, fetch: f });

describe("WahaSessionAdmin", () => {
  it("create posts name and start:true with the API key", async () => {
    const { fn, calls } = fakeFetch(() => json({ name: "t_abc", status: "STARTING" }, 201));
    await make(fn).create("t_abc");
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/sessions`, method: "POST" });
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]?.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ name: "t_abc", start: true });
  });

  it("state reads the status and maps unknown values to UNKNOWN", async () => {
    for (const s of ["STOPPED", "STARTING", "SCAN_QR_CODE", "WORKING", "FAILED"]) {
      const { fn, calls } = fakeFetch(() => json({ name: "t_abc", status: s }));
      expect(await make(fn).state("t_abc")).toBe(s);
      expect(calls[0]?.url).toBe(`${BASE}/api/sessions/t_abc`);
      expect(calls[0]?.method).toBe("GET");
    }
    expect(await make(fakeFetch(() => json({ status: "PAUSED" })).fn).state("x")).toBe("UNKNOWN");
    expect(await make(fakeFetch(() => json({})).fn).state("x")).toBe("UNKNOWN");
  });

  it("state is UNKNOWN when the session does not exist (404)", async () => {
    expect(await make(fakeFetch(() => json({}, 404)).fn).state("x")).toBe("UNKNOWN");
  });

  it("qr returns the base64 image only while the session is SCAN_QR_CODE", async () => {
    const { fn, calls } = fakeFetch((r) =>
      r.url.endsWith("/api/sessions/t_abc")
        ? json({ status: "SCAN_QR_CODE" })
        : json({ mimetype: "image/png", data: "QUJD" }),
    );
    expect(await make(fn).qr("t_abc")).toEqual({ mimetype: "image/png", base64: "QUJD" });
    const qrCall = calls[1];
    expect(qrCall?.url).toBe(`${BASE}/api/t_abc/auth/qr?format=image`);
    expect(qrCall?.headers.accept).toBe("application/json");
  });

  it("qr is null in any other state without requesting the QR", async () => {
    const { fn, calls } = fakeFetch(() => json({ status: "WORKING" }));
    expect(await make(fn).qr("t_abc")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("qr is null when WAHA answers 404/422 for the QR", async () => {
    for (const status of [404, 422]) {
      const { fn } = fakeFetch((r) =>
        r.url.includes("/auth/qr") ? json({}, status) : json({ status: "SCAN_QR_CODE" }),
      );
      expect(await make(fn).qr("t_abc")).toBeNull();
    }
  });

  it("me returns the account id, or null when none is linked", async () => {
    const { fn, calls } = fakeFetch(() => json({ id: "5491100000000@c.us", pushName: "Ana" }));
    expect(await make(fn).me("t_abc")).toEqual({ id: "5491100000000@c.us" });
    expect(calls[0]?.url).toBe(`${BASE}/api/sessions/t_abc/me`);
    expect(await make(fakeFetch(() => json(null)).fn).me("t_abc")).toBeNull();
    expect(
      await make(fakeFetch(() => new Response("", { status: 200 })).fn).me("t_abc"),
    ).toBeNull();
    expect(await make(fakeFetch(() => json({}, 404)).fn).me("t_abc")).toBeNull();
  });

  it("logout posts to the logout path", async () => {
    const { fn, calls } = fakeFetch(() => json({ name: "t_abc" }, 201));
    await make(fn).logout("t_abc");
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/sessions/t_abc/logout`, method: "POST" });
  });

  it("start posts to the start path", async () => {
    const { fn, calls } = fakeFetch(() => json({ name: "t_abc", status: "STARTING" }, 201));
    await make(fn).start("t_abc");
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/sessions/t_abc/start`, method: "POST" });
  });

  it("restart posts to the restart path", async () => {
    const { fn, calls } = fakeFetch(() => json({ name: "t_abc", status: "STARTING" }, 201));
    await make(fn).restart("t_abc");
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/sessions/t_abc/restart`, method: "POST" });
  });

  it("remove deletes the session and treats 404 as success", async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    await make(fn).remove("t_abc");
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/sessions/t_abc`, method: "DELETE" });
    await expect(make(fakeFetch(() => json({}, 404)).fn).remove("t_abc")).resolves.toBeUndefined();
  });

  it("encodes the session name in paths", async () => {
    const { fn, calls } = fakeFetch(() => json({ status: "WORKING" }));
    await make(fn).state("a b/c");
    expect(calls[0]?.url).toBe(`${BASE}/api/sessions/a%20b%2Fc`);
  });

  it("maps 401/403 to WahaAuthError and 5xx / network errors to WahaUnavailableError", async () => {
    for (const status of [401, 403]) {
      await expect(make(fakeFetch(() => json({}, status)).fn).create("x")).rejects.toBeInstanceOf(
        WahaAuthError,
      );
    }
    await expect(make(fakeFetch(() => json({}, 500)).fn).state("x")).rejects.toBeInstanceOf(
      WahaUnavailableError,
    );
    const boom = (async () => {
      throw new Error(`connect failed ${BASE} ${KEY}`);
    }) as typeof fetch;
    const err = await make(boom)
      .logout("x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WahaUnavailableError);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(String((err as Error).message)).not.toContain("waha-internal");
  });

  it("never includes the API key in error messages", async () => {
    for (const status of [401, 409, 500, 502]) {
      const err = await make(fakeFetch(() => json({ key: KEY }, status)).fn)
        .create("x")
        .catch((e: unknown) => e);
      expect(String((err as Error).message)).not.toContain(KEY);
    }
  });

  it("does not follow redirects (would resend the API key)", async () => {
    let redirect: RequestInit["redirect"];
    const f = (async (_u: unknown, init?: RequestInit) => {
      redirect = init?.redirect;
      return json({ status: "WORKING" });
    }) as typeof fetch;
    await make(f).state("x");
    expect(redirect).toBe("error");
  });

  it("times out with WahaUnavailableError even if fetch ignores the abort signal", async () => {
    const hang = (() => new Promise<Response>(() => {})) as typeof fetch;
    const admin = createWahaSessionAdmin({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: hang,
      timeoutMs: 20,
    });
    const err = await admin.state("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WahaUnavailableError);
    expect((err as Error).message).toBe("WAHA request timed out.");
  });

  it("qr is null when the QR JSON lacks mimetype or data", async () => {
    for (const qr of [{ data: "QUJD" }, { mimetype: "image/png" }, {}]) {
      const { fn } = fakeFetch((r) =>
        r.url.includes("/auth/qr") ? json(qr) : json({ status: "SCAN_QR_CODE" }),
      );
      expect(await make(fn).qr("t_abc")).toBeNull();
    }
  });

  describe("webhooks", () => {
    const HOOK = { url: "https://mcp.example.com/webhooks/waha", secret: "whsec-123" };
    const OURS = {
      url: HOOK.url,
      events: ["message.any", "session.status"],
      hmac: { key: HOOK.secret },
      retries: { policy: "exponential", delaySeconds: 2, attempts: 9 },
      customHeaders: null,
    };
    const OTHER = { url: "https://n8n.example.com/hook", events: ["message"], hmac: null };

    /** GET answers `session`; PUT records the body and answers 200. */
    function wahaWith(session: unknown, getStatus = 200) {
      return fakeFetch((r) => (r.method === "GET" ? json(session, getStatus) : json({}, 200)));
    }

    it("create sends the webhook in the new session's config when given one", async () => {
      const { fn, calls } = fakeFetch(() => json({ name: "t_abc" }, 201));
      await make(fn).create("t_abc", { webhook: HOOK });
      expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
        name: "t_abc",
        start: true,
        config: { webhooks: [OURS] },
      });
    });

    it("configureWebhook adds ours, keeping other webhooks and config untouched", async () => {
      const config = { metadata: { a: "1" }, proxy: null, webhooks: [OTHER] };
      const { fn, calls } = wahaWith({ name: "t_abc", status: "WORKING", config });
      await make(fn).configureWebhook("t_abc", HOOK);
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `GET ${BASE}/api/sessions/t_abc`,
        `PUT ${BASE}/api/sessions/t_abc`,
      ]);
      expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
        name: "t_abc",
        config: { metadata: { a: "1" }, proxy: null, webhooks: [OTHER, OURS] },
      });
    });

    it("configureWebhook replaces an outdated webhook with our url (e.g. a rotated secret)", async () => {
      const stale = { ...OURS, hmac: { key: "old" }, events: ["message"] };
      const { fn, calls } = wahaWith({
        name: "t_abc",
        config: { webhooks: [stale, OTHER, { ...stale }] },
      });
      await make(fn).configureWebhook("t_abc", HOOK);
      expect(JSON.parse(calls[1]?.body ?? "").config.webhooks).toEqual([OTHER, OURS]);
    });

    it("configureWebhook does not PUT (no session restart) when ours is already there", async () => {
      // WAHA may echo extra defaults and another event order; neither is a difference.
      const echoed = { ...OURS, events: ["session.status", "message.any"], customHeaders: [] };
      const { fn, calls } = wahaWith({ name: "t_abc", config: { webhooks: [OTHER, echoed] } });
      await make(fn).configureWebhook("t_abc", HOOK);
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
    });

    it("configureWebhook rewrites ours when it still has the old 30-second constant retries", async () => {
      const old = { ...OURS, retries: { policy: "constant", delaySeconds: 2, attempts: 15 } };
      const { fn, calls } = wahaWith({ name: "t_abc", config: { webhooks: [old] } });
      await make(fn).configureWebhook("t_abc", HOOK);
      expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
      expect(JSON.parse(calls[1]?.body ?? "").config.webhooks).toEqual([OURS]);
    });

    it("asks WAHA for retries that span about 30 minutes", () => {
      // WAHA's exponential delay before retry n is 2^n * delaySeconds (+0-20% jitter).
      const { delaySeconds, attempts } = OURS.retries;
      let total = 0;
      for (let n = 1; n <= attempts; n++) total += 2 ** n * delaySeconds;
      expect(total).toBeGreaterThanOrEqual(30 * 60);
      expect(total * 1.2).toBeLessThanOrEqual(45 * 60);
    });

    it("configureWebhook writes a config for a session that has none", async () => {
      const { fn, calls } = wahaWith({ name: "t_abc", status: "STOPPED", config: null });
      await make(fn).configureWebhook("t_abc", HOOK);
      expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
        name: "t_abc",
        config: { webhooks: [OURS] },
      });
    });

    it("configureWebhook fails for a missing session and never leaks the secret", async () => {
      const missing = await make(wahaWith({}, 404).fn)
        .configureWebhook("t_abc", HOOK)
        .catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(WahaUnavailableError);
      const failing = fakeFetch((r) =>
        r.method === "GET" ? json({ config: null }) : json({ echo: HOOK.secret }, 500),
      );
      const err = await make(failing.fn)
        .configureWebhook("t_abc", HOOK)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WahaUnavailableError);
      expect(String((err as Error).message)).not.toContain(HOOK.secret);
    });
  });
});
