import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WahaAuthError,
  WahaNotFoundError,
  WahaUnavailableError,
} from "../../../src/domain/errors.js";
import { createWahaHttpGateway } from "../../../src/infrastructure/waha/WahaHttpGateway.js";

const BASE = "http://waha-internal:3000";
const KEY = "k-secret";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect?: RequestInit["redirect"];
}

function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return respond(url);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const make = (f: typeof fetch, extra: { timeoutMs?: number } = {}) =>
  createWahaHttpGateway({ baseUrl: BASE, apiKey: KEY, session: "my session", fetch: f, ...extra });

describe("WahaHttpGateway", () => {
  it("sends X-Api-Key and session in path", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes("/api/sessions/"))
        return json({ engine: { engine: "GOWS" }, status: "WORKING" });
      if (url.endsWith("/groups")) return json([{ id: "1@g.us" }]);
      if (url.includes("/groups/")) return json({ id: "1@g.us" });
      return json([]);
    });
    const gw = make(fn);
    expect(await gw.getSession()).toEqual({ engine: "GOWS", status: "WORKING" });
    await gw.listGroups();
    await gw.getGroup("1@g.us");
    await gw.getMessages("1@g.us", { limit: 10, offset: 0 });

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/sessions/my%20session",
      "/api/my%20session/groups",
      "/api/my%20session/groups/1%40g.us",
      "/api/my%20session/chats/1%40g.us/messages",
    ]);
    for (const c of calls) {
      expect(c.method).toBe("GET");
      expect(c.headers["x-api-key"]).toBe(KEY);
      expect(c.url.startsWith(BASE)).toBe(true);
    }
  });

  it("never follows redirects and maps a 302 to WahaUnavailableError", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: "http://evil.example/x" } }),
    );
    const gw = make(fn);
    await expect(gw.listGroups()).rejects.toBeInstanceOf(WahaUnavailableError);
    await expect(gw.openMedia("/api/files/a.jpg")).rejects.toBeInstanceOf(WahaUnavailableError);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.redirect === "error")).toBe(true);
  });

  it("maps 401 to WahaAuthError", async () => {
    const { fn } = fakeFetch(() => new Response("no", { status: 401 }));
    await expect(make(fn).listGroups()).rejects.toBeInstanceOf(WahaAuthError);
  });

  it("maps 404 on getGroup to WahaNotFoundError", async () => {
    const { fn } = fakeFetch(() => new Response("no", { status: 404 }));
    await expect(make(fn).getGroup("x@g.us")).rejects.toBeInstanceOf(WahaNotFoundError);
  });

  it("maps 500 and network error to WahaUnavailableError", async () => {
    const f500 = fakeFetch(() => new Response("boom", { status: 500 }));
    await expect(make(f500.fn).listGroups()).rejects.toBeInstanceOf(WahaUnavailableError);
    const net = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(make(net).listGroups()).rejects.toBeInstanceOf(WahaUnavailableError);
  });

  it("maps timeout to WahaUnavailableError", async () => {
    const never = (() => new Promise(() => {})) as unknown as typeof fetch;
    await expect(make(never, { timeoutMs: 10 }).listGroups()).rejects.toBeInstanceOf(
      WahaUnavailableError,
    );
  });

  it("error messages never contain apiKey or baseUrl", async () => {
    const cases: Array<typeof fetch> = [
      fakeFetch(() => new Response("x", { status: 401 })).fn,
      fakeFetch(() => new Response("x", { status: 404 })).fn,
      fakeFetch(() => new Response(`${KEY} ${BASE}`, { status: 500 })).fn,
      (async () => {
        throw new TypeError(`connect ECONNREFUSED ${BASE} ${KEY}`);
      }) as typeof fetch,
    ];
    for (const f of cases) {
      const err = await make(f)
        .getGroup("x@g.us")
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      const text = `${(err as Error).message} ${String((err as Error).cause ?? "")}`;
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("waha-internal");
    }
  });

  it("getMessages passes timestamp filters and downloadMedia=false", async () => {
    const { fn, calls } = fakeFetch(() => json([]));
    await make(fn).getMessages("1@g.us", { limit: 50, offset: 5, from: 100, to: 200 });
    const q = new URL(calls[0]?.url ?? "").searchParams;
    expect(q.get("limit")).toBe("50");
    expect(q.get("offset")).toBe("5");
    expect(q.get("filter.timestamp.gte")).toBe("100");
    expect(q.get("filter.timestamp.lte")).toBe("200");
    expect(q.get("downloadMedia")).toBe("false");
  });

  it("getMessages omits timestamp filters when not given", async () => {
    const { fn, calls } = fakeFetch(() => json([]));
    await make(fn).getMessages("1@g.us", { limit: 1, offset: 0 });
    const q = new URL(calls[0]?.url ?? "").searchParams;
    expect(q.has("filter.timestamp.gte")).toBe(false);
    expect(q.has("filter.timestamp.lte")).toBe(false);
  });

  it("listChats requests the session chats with limit and offset", async () => {
    const { fn, calls } = fakeFetch(() => json([{ id: "1@c.us" }]));
    expect(await make(fn).listChats({ limit: 500, offset: 20 })).toEqual([{ id: "1@c.us" }]);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/my%20session/chats");
    expect(url.searchParams.get("limit")).toBe("500");
    expect(url.searchParams.get("offset")).toBe("20");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.redirect).toBe("error");
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
  });

  it("listContacts passes the session as a query parameter", async () => {
    const { fn, calls } = fakeFetch(() => json([{ id: "1@c.us" }]));
    expect(await make(fn).listContacts({ limit: 5000, offset: 0 })).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/contacts/all");
    expect(url.searchParams.get("session")).toBe("my session");
    expect(url.searchParams.get("limit")).toBe("5000");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.redirect).toBe("error");
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
  });

  it("listChats and listContacts map errors with fixed messages and tolerate non-arrays", async () => {
    const f401 = fakeFetch(() => new Response("no", { status: 401 }));
    await expect(make(f401.fn).listChats({ limit: 1, offset: 0 })).rejects.toBeInstanceOf(
      WahaAuthError,
    );
    const f500 = fakeFetch(() => new Response("boom", { status: 500 }));
    const err = await make(f500.fn)
      .listContacts({ limit: 1, offset: 0 })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(WahaUnavailableError);
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).not.toContain("waha-internal");
    const obj = fakeFetch(() => json({ not: "an array" }));
    expect(await make(obj.fn).listChats({ limit: 1, offset: 0 })).toEqual([]);
  });

  it("openMedia returns null on 404 and 410", async () => {
    const { fn } = fakeFetch(() => new Response("gone", { status: 404 }));
    expect(await make(fn).openMedia(`${BASE}/api/files/a.jpg`)).toBeNull();
    const f410 = fakeFetch(() => new Response("gone", { status: 410 }));
    expect(await make(f410.fn).openMedia("/api/files/a.jpg")).toBeNull();
  });

  it("openMedia returns an unread stream, mimetype and declared length, with the api key", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const { fn, calls } = fakeFetch(
      () =>
        new Response(body, {
          headers: { "content-type": "image/jpeg; q=1", "content-length": "3" },
        }),
    );
    const media = await make(fn).openMedia(`${BASE}/api/files/a.jpg`);
    expect(media?.mimetype).toBe("image/jpeg");
    expect(media?.length).toBe(3);
    expect(pulls).toBe(0);
    expect(Array.from(new Uint8Array(await new Response(media?.body).arrayBuffer()))).toEqual([
      1, 2, 3,
    ]);
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]?.redirect).toBe("error");
  });

  it("openMedia reports length null when Content-Length is missing or invalid", async () => {
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([9]));
          c.close();
        },
      });
    for (const headers of [{}, { "content-length": "abc" }, { "content-length": "-1" }]) {
      const { fn } = fakeFetch(() => {
        const res = new Response(stream());
        for (const [k, v] of Object.entries(headers)) res.headers.set(k, v as string);
        return res;
      });
      expect((await make(fn).openMedia("/api/files/a.bin"))?.length).toBeNull();
    }
  });

  it("openMedia's timeout covers the headers, not the streamed body", async () => {
    let signal: AbortSignal | undefined;
    const slowBody = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(new Uint8Array([1]));
    }) as typeof fetch;
    await make(slowBody, { timeoutMs: 10 }).openMedia("/api/files/a.bin");
    await new Promise((r) => setTimeout(r, 30));
    expect(signal?.aborted).toBe(false);
    const never = (() => new Promise(() => {})) as unknown as typeof fetch;
    await expect(
      make(never, { timeoutMs: 10 }).openMedia("/api/files/a.bin"),
    ).rejects.toBeInstanceOf(WahaUnavailableError);
  });

  it("openMedia fetches baseUrl + path even when the URL has another host", async () => {
    const { fn, calls } = fakeFetch(() => new Response(new Uint8Array([9])));
    await make(fn).openMedia("http://localhost:3000/api/files/default/a.jpg?x=1");
    expect(calls[0]?.url).toBe(`${BASE}/api/files/default/a.jpg?x=1`);
  });

  it("openMedia refuses paths outside /api/files/", async () => {
    const { fn, calls } = fakeFetch(() => new Response("x"));
    const gw = make(fn);
    for (const u of [
      `${BASE}/api/sessions`,
      "http://evil.example/admin",
      "/api/files/../sessions",
      "not a url at all \u0000",
    ]) {
      await expect(gw.openMedia(u)).rejects.toBeInstanceOf(WahaNotFoundError);
    }
    expect(calls).toHaveLength(0);
  });

  it("getMessage requests one message with downloadMedia=true", async () => {
    const single = JSON.parse(
      readFileSync("test/fixtures/gows/message-single-download.json", "utf8"),
    ) as { id: string };
    const { fn, calls } = fakeFetch(() => json(single));
    const out = await make(fn).getMessage("1@g.us", "false_1@g.us_ABC_2@lid");
    expect(out).toEqual(single);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe(
      "/api/my%20session/chats/1%40g.us/messages/false_1%40g.us_ABC_2%40lid",
    );
    expect(url.searchParams.get("downloadMedia")).toBe("true");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.redirect).toBe("error");
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
  });

  it("getMessage maps 404 to WahaNotFoundError and 401 to WahaAuthError", async () => {
    const nf = fakeFetch(() => new Response("no", { status: 404 }));
    await expect(make(nf.fn).getMessage("1@g.us", "x")).rejects.toBeInstanceOf(WahaNotFoundError);
    const auth = fakeFetch(() => new Response("no", { status: 401 }));
    await expect(make(auth.fn).getMessage("1@g.us", "x")).rejects.toBeInstanceOf(WahaAuthError);
  });
});
