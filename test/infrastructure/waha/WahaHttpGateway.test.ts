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
}

function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
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

  it("fetchMedia returns null on 404", async () => {
    const { fn } = fakeFetch(() => new Response("gone", { status: 404 }));
    expect(await make(fn).fetchMedia(`${BASE}/api/files/a.jpg`)).toBeNull();
    const f410 = fakeFetch(() => new Response("gone", { status: 410 }));
    expect(await make(f410.fn).fetchMedia("/api/files/a.jpg")).toBeNull();
  });

  it("fetchMedia returns bytes and mimetype with the api key", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }),
    );
    const media = await make(fn).fetchMedia(`${BASE}/api/files/a.jpg`);
    expect(media?.mimetype).toBe("image/jpeg");
    expect(Array.from(media?.bytes ?? [])).toEqual([1, 2, 3]);
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
  });

  it("fetchMedia fetches baseUrl + path even when the URL has another host", async () => {
    const { fn, calls } = fakeFetch(() => new Response(new Uint8Array([9])));
    await make(fn).fetchMedia("http://localhost:3000/api/files/default/a.jpg?x=1");
    expect(calls[0]?.url).toBe(`${BASE}/api/files/default/a.jpg?x=1`);
  });

  it("fetchMedia refuses paths outside /api/files/", async () => {
    const { fn, calls } = fakeFetch(() => new Response("x"));
    const gw = make(fn);
    for (const u of [
      `${BASE}/api/sessions`,
      "http://evil.example/admin",
      "/api/files/../sessions",
      "not a url at all \u0000",
    ]) {
      await expect(gw.fetchMedia(u)).rejects.toBeInstanceOf(WahaNotFoundError);
    }
    expect(calls).toHaveLength(0);
  });
});
