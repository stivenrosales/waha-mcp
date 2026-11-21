import { describe, expect, it } from "vitest";
import {
  InvalidInputError,
  MediaSendUnsupportedError,
  SendOutcomeUnknownError,
  WahaAuthError,
  WahaNotFoundError,
  WahaUnavailableError,
  WhatsAppDisconnectedError,
} from "../../../src/domain/errors.js";
import { createWahaHttpSender } from "../../../src/infrastructure/waha/WahaHttpSender.js";

const BASE = "http://waha-internal:3000";
const KEY = "k-secret";

interface Recorded {
  path: string;
  method: string;
  headers: Record<string, string>;
  redirect?: RequestInit["redirect"];
  body: Record<string, unknown>;
}

function fakeFetch(respond: (path: string) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({
      path,
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return respond(path);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ok = () => json({ id: "true_1@c.us_ABC", timestamp: 1730000000 });

const make = (f: typeof fetch, timeoutMs?: number) =>
  createWahaHttpSender({
    baseUrl: `${BASE}/`,
    apiKey: KEY,
    session: "default",
    fetch: f,
    timeoutMs,
  });

const FILE = {
  data: new TextEncoder().encode("hola ñ"),
  mimetype: "application/pdf",
  filename: "Cotización Ñandú 🎉.pdf",
};

describe("WahaHttpSender", () => {
  it("sendText POSTs JSON with the key, no redirects, and returns the sent id", async () => {
    const { fn, calls } = fakeFetch(ok);
    const sent = await make(fn).sendText({ chatId: "1@c.us", text: "hola" });
    expect(sent).toEqual({ id: "true_1@c.us_ABC", timestamp: 1730000000 });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Recorded;
    expect(call.path).toBe("/api/sendText");
    expect(call.method).toBe("POST");
    expect(call.redirect).toBe("error");
    expect(call.headers["x-api-key"]).toBe(KEY);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({ session: "default", chatId: "1@c.us", text: "hola" });
  });

  it("sendText forwards reply_to and mentions", async () => {
    const { fn, calls } = fakeFetch(ok);
    await make(fn).sendText({
      chatId: "1@g.us",
      text: "hola @51999",
      replyTo: "false_1@g.us_X",
      mentions: ["51999@c.us"],
    });
    expect(calls[0]?.body).toEqual({
      session: "default",
      chatId: "1@g.us",
      text: "hola @51999",
      reply_to: "false_1@g.us_X",
      mentions: ["51999@c.us"],
    });
  });

  it("reads a serialized id object", async () => {
    const { fn } = fakeFetch(() => json({ id: { _serialized: "true_1@c.us_Z" } }));
    expect(await make(fn).sendText({ chatId: "1@c.us", text: "x" })).toEqual({
      id: "true_1@c.us_Z",
      timestamp: null,
    });
  });

  it("sends files as base64 data with mimetype and filename", async () => {
    const { fn, calls } = fakeFetch(ok);
    const s = make(fn);
    await s.sendFile({ chatId: "1@c.us", file: FILE, caption: "*ok*", replyTo: "r" });
    await s.sendImage({
      chatId: "1@c.us",
      file: { url: "https://x.io/a.jpg", mimetype: "image/jpeg", filename: "a.jpg" },
    });
    expect(calls.map((c) => c.path)).toEqual(["/api/sendFile", "/api/sendImage"]);
    expect(calls[0]?.body).toEqual({
      session: "default",
      chatId: "1@c.us",
      caption: "*ok*",
      reply_to: "r",
      file: {
        mimetype: "application/pdf",
        filename: "Cotización Ñandú 🎉.pdf",
        data: Buffer.from("hola ñ").toString("base64"),
      },
    });
    expect(calls[1]?.body.file).toEqual({
      mimetype: "image/jpeg",
      filename: "a.jpg",
      url: "https://x.io/a.jpg",
    });
  });

  it("asks WAHA to convert voice notes and videos", async () => {
    const { fn, calls } = fakeFetch(ok);
    const s = make(fn);
    await s.sendVoice({ chatId: "1@c.us", file: { ...FILE, mimetype: "audio/ogg" } });
    await s.sendVideo({ chatId: "1@c.us", file: { ...FILE, mimetype: "video/mp4" }, caption: "v" });
    expect(calls.map((c) => [c.path, c.body.convert])).toEqual([
      ["/api/sendVoice", true],
      ["/api/sendVideo", true],
    ]);
  });

  it("sends locations and contact cards", async () => {
    const { fn, calls } = fakeFetch(ok);
    const s = make(fn);
    await s.sendLocation({
      chatId: "1@c.us",
      latitude: -12.0464,
      longitude: -77.0428,
      title: "Lima",
    });
    await s.sendContact({
      chatId: "1@c.us",
      fullName: "Ana Pérez",
      phoneNumber: "+51 999 888 777",
    });
    expect(calls[0]).toMatchObject({
      path: "/api/sendLocation",
      body: {
        session: "default",
        chatId: "1@c.us",
        latitude: -12.0464,
        longitude: -77.0428,
        title: "Lima",
      },
    });
    expect(calls[1]).toMatchObject({
      path: "/api/sendContactVcard",
      body: {
        session: "default",
        chatId: "1@c.us",
        contacts: [
          { fullName: "Ana Pérez", phoneNumber: "+51 999 888 777", whatsappId: "51999888777" },
        ],
      },
    });
  });

  it("reports an unknown outcome when WAHA cannot be reached or times out", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(make(down).sendText({ chatId: "1@c.us", text: "x" })).rejects.toBeInstanceOf(
      SendOutcomeUnknownError,
    );
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await expect(make(hang, 20).sendText({ chatId: "1@c.us", text: "x" })).rejects.toBeInstanceOf(
      SendOutcomeUnknownError,
    );
  });

  it("maps HTTP errors to domain errors", async () => {
    const send = (res: Response) =>
      make(fakeFetch(() => res).fn).sendText({ chatId: "1@c.us", text: "x" });
    await expect(send(json({}, 401))).rejects.toBeInstanceOf(WahaAuthError);
    await expect(send(json({}, 404))).rejects.toBeInstanceOf(WahaNotFoundError);
    await expect(send(json({}, 500))).rejects.toBeInstanceOf(WahaUnavailableError);
    const bad = send(json({ message: "chatId is invalid" }, 400));
    await expect(bad).rejects.toBeInstanceOf(InvalidInputError);
    await expect(bad).rejects.toThrow("WAHA rejected the message: chatId is invalid");
  });

  it("reports a refused connection as unreachable, since nothing was sent", async () => {
    const refused = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const err = await make(refused)
      .sendText({ chatId: "1@c.us", text: "x" })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(WahaUnavailableError);
    expect(err).not.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("treats other 422s on media as a rejected message, not as an old WAHA", async () => {
    const { fn } = fakeFetch(() => json({ message: "file.mimetype is not supported" }, 422));
    const err = await make(fn)
      .sendImage({ chatId: "1@c.us", file: FILE })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect((err as Error).message).toContain("file.mimetype is not supported");
  });

  it("not-WORKING response → WhatsAppDisconnectedError", async () => {
    const notWorking = json(
      {
        message: "Session status is not as expected. Try again later or restart the session",
        session: "default",
        status: "SCAN_QR_CODE",
        expected: ["WORKING"],
      },
      422,
    );
    await expect(
      make(fakeFetch(() => notWorking.clone()).fn).sendText({ chatId: "1@c.us", text: "x" }),
    ).rejects.toBeInstanceOf(WhatsAppDisconnectedError);
    await expect(
      make(fakeFetch(() => notWorking.clone()).fn).sendImage({ chatId: "1@c.us", file: FILE }),
    ).rejects.toBeInstanceOf(WhatsAppDisconnectedError);
  });

  it("reports media sending as unsupported on WAHA builds without it", async () => {
    for (const res of [
      json({ message: "Available in WAHA Plus" }, 422),
      json({}, 501),
      json({ message: "This feature is available only in Plus version" }, 400),
    ]) {
      const { fn } = fakeFetch(() => res);
      await expect(make(fn).sendImage({ chatId: "1@c.us", file: FILE })).rejects.toBeInstanceOf(
        MediaSendUnsupportedError,
      );
    }
  });

  it("posts seen and typing actions with the session", async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    const s = make(fn);
    await s.sendSeen({ chatId: "1@c.us", messageIds: ["a", "b"] });
    await s.sendSeen({ chatId: "1@c.us" });
    await s.startTyping("1@c.us");
    await s.stopTyping("1@c.us");
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/sendSeen", { session: "default", chatId: "1@c.us", messageIds: ["a", "b"] }],
      ["POST", "/api/sendSeen", { session: "default", chatId: "1@c.us" }],
      ["POST", "/api/startTyping", { session: "default", chatId: "1@c.us" }],
      ["POST", "/api/stopTyping", { session: "default", chatId: "1@c.us" }],
    ]);
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
  });

  it("maps presence action failures like sends", async () => {
    const { fn } = fakeFetch(() => json({}, 401));
    await expect(make(fn).startTyping("1@c.us")).rejects.toBeInstanceOf(WahaAuthError);
  });

  it("never leaks the key or base URL in errors", async () => {
    for (const res of [json({ message: `bad ${KEY}` }, 400), json({}, 500)]) {
      const { fn } = fakeFetch(() => res);
      const err = await make(fn)
        .sendText({ chatId: "1@c.us", text: "x" })
        .catch((e: Error) => e);
      expect(String((err as Error).message)).not.toContain(KEY);
      expect(String((err as Error).message)).not.toContain("waha-internal");
    }
  });
});

describe("post regression", () => {
  it("sends POST with the session in the body and labels a 404 as a chat", async () => {
    const f = fakeFetch(() => ok());
    await make(f.fn).sendText({ chatId: "1@c.us", text: "x" });
    expect(f.calls[0]?.method).toBe("POST");
    expect(f.calls[0]?.body.session).toBe("default");
    await expect(
      make(fakeFetch(() => json({}, 404)).fn).sendText({ chatId: "1@c.us", text: "x" }),
    ).rejects.toThrow("WAHA chat not found.");
  });

  it("react PUTs /api/reaction with session in the body", async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    await make(fn).react({ messageId: "true_1@c.us_A", emoji: "👍" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: "/api/reaction",
      method: "PUT",
      body: { session: "default", messageId: "true_1@c.us_A", reaction: "👍" },
    });
  });

  it('react with "" removes the reaction', async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    await make(fn).react({ messageId: "true_1@c.us_A", emoji: "" });
    expect(calls[0]?.body.reaction).toBe("");
  });

  it("react: 404 becomes WahaNotFoundError(message)", async () => {
    const { fn } = fakeFetch(() => json({ message: "nope" }, 404));
    await expect(make(fn).react({ messageId: "true_1@c.us_A", emoji: "👍" })).rejects.toEqual(
      new WahaNotFoundError("message"),
    );
  });

  it("editMessage PUTs the encoded path without session in the body", async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    await make(fn).editMessage({
      chatId: "51999@c.us",
      messageId: "true_51999@c.us_ABC",
      text: "x",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: "/api/default/chats/51999%40c.us/messages/true_51999%40c.us_ABC",
      method: "PUT",
      body: { text: "x" },
    });
    expect(calls[0]?.body).not.toHaveProperty("session");
  });

  it("editMessage: 422 becomes InvalidInputError, 404 WahaNotFoundError(message)", async () => {
    const q = { chatId: "1@c.us", messageId: "true_1@c.us_A", text: "x" };
    const bad = fakeFetch(() => json({ message: "too old" }, 422));
    await expect(make(bad.fn).editMessage(q)).rejects.toBeInstanceOf(InvalidInputError);
    const gone = fakeFetch(() => json({}, 404));
    await expect(make(gone.fn).editMessage(q)).rejects.toEqual(new WahaNotFoundError("message"));
  });

  it("deleteMessage sends DELETE to the encoded path with no body and no Content-Type", async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    await make(fn).deleteMessage({ chatId: "51999@c.us", messageId: "true_51999@c.us_ABC" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: "/api/default/chats/51999%40c.us/messages/true_51999%40c.us_ABC",
      method: "DELETE",
      body: {},
    });
    expect(calls[0]?.headers).not.toHaveProperty("content-type");
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
  });

  it("deleteMessage: 404 becomes WahaNotFoundError(message), 422 InvalidInputError", async () => {
    const q = { chatId: "1@c.us", messageId: "true_1@c.us_A" };
    const gone = fakeFetch(() => json({}, 404));
    await expect(make(gone.fn).deleteMessage(q)).rejects.toEqual(new WahaNotFoundError("message"));
    const bad = fakeFetch(() => json({ message: "too old" }, 422));
    await expect(make(bad.fn).deleteMessage(q)).rejects.toBeInstanceOf(InvalidInputError);
  });
});
