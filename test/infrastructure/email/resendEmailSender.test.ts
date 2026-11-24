import { describe, expect, it } from "vitest";
import { EmailSendError } from "../../../src/domain/errors.js";
import { createResendEmailSender } from "../../../src/infrastructure/email/resendEmailSender.js";

const KEY = "re_secret_key";
const opts = (fetchImpl: typeof fetch) => ({
  apiKey: KEY,
  from: "Zenbox <hola@usezenbox.com>",
  fetch: fetchImpl,
});

describe("createResendEmailSender", () => {
  it("posts the message to Resend with the bearer key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = createResendEmailSender(
      opts(async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(JSON.stringify({ id: "e1" }), { status: 200 });
      }),
    );
    await sender.send({
      to: "ana@example.com",
      subject: "Hola",
      text: "texto",
      html: "<p>texto</p>",
    });
    const call = calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(call.init.body))).toEqual({
      from: "Zenbox <hola@usezenbox.com>",
      to: ["ana@example.com"],
      subject: "Hola",
      text: "texto",
      html: "<p>texto</p>",
    });
  });

  it("turns a rejected send into a fixed error without Resend's body or the key", async () => {
    const sender = createResendEmailSender(
      opts(async () => new Response(JSON.stringify({ message: `bad ${KEY}` }), { status: 403 })),
    );
    const err = await sender.send({ to: "a@b.co", subject: "s", text: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.kind).toBe("auth");
    expect(String(err.message)).not.toContain(KEY);
  });

  it("classifies throttling, invalid messages, network failures and replies without an id", async () => {
    const kind = async (f: typeof fetch) =>
      (
        await createResendEmailSender(opts(f))
          .send({ to: "a@b.co", subject: "s", text: "t" })
          .catch((e) => e)
      ).kind;
    expect(await kind(async () => new Response("{}", { status: 429 }))).toBe("rateLimited");
    expect(await kind(async () => new Response("{}", { status: 422 }))).toBe("rejected");
    expect(
      await kind(async () => {
        throw new TypeError("fetch failed");
      }),
    ).toBe("failed");
    expect(await kind(async () => new Response("{}", { status: 200 }))).toBe("failed");
  });
});
