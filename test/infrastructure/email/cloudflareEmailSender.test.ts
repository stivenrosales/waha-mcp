import { describe, expect, it } from "vitest";
import { EmailSendError } from "../../../src/domain/errors.js";
import { createCloudflareEmailSender } from "../../../src/infrastructure/email/cloudflareEmailSender.js";

const TOKEN = "cf-secret-token";
const opts = (fetchImpl: typeof fetch) => ({
  accountId: "acc123",
  apiToken: TOKEN,
  from: "Zenbox <hola@usezenbox.com>",
  fetch: fetchImpl,
});

describe("createCloudflareEmailSender", () => {
  it("posts the message to the account's send endpoint with the bearer token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = createCloudflareEmailSender(
      opts(async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(JSON.stringify({ success: true, result: { message_id: "m1" } }), {
          status: 200,
        });
      }),
    );
    await sender.send({
      to: "ana@example.com",
      subject: "Hola",
      text: "texto",
      html: "<p>texto</p>",
    });
    expect(calls).toHaveLength(1);
    const call = calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send",
    );
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(call.init.body))).toEqual({
      from: "Zenbox <hola@usezenbox.com>",
      to: "ana@example.com",
      subject: "Hola",
      text: "texto",
      html: "<p>texto</p>",
    });
  });

  it("turns a rejected send into a fixed error without the provider body or token", async () => {
    const sender = createCloudflareEmailSender(
      opts(
        async () =>
          new Response(
            JSON.stringify({ success: false, errors: [{ code: 10101, message: `bad ${TOKEN}` }] }),
            { status: 401 },
          ),
      ),
    );
    const err = await sender.send({ to: "a@b.co", subject: "s", text: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.kind).toBe("auth");
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it("classifies throttling, network failures and success:false bodies", async () => {
    const throttled = createCloudflareEmailSender(
      opts(async () => new Response("{}", { status: 429 })),
    );
    expect(
      (await throttled.send({ to: "a@b.co", subject: "s", text: "t" }).catch((e) => e)).kind,
    ).toBe("rateLimited");
    const down = createCloudflareEmailSender(
      opts(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect((await down.send({ to: "a@b.co", subject: "s", text: "t" }).catch((e) => e)).kind).toBe(
      "failed",
    );
    const notOk = createCloudflareEmailSender(
      opts(async () => new Response(JSON.stringify({ success: false }), { status: 200 })),
    );
    expect((await notOk.send({ to: "a@b.co", subject: "s", text: "t" }).catch((e) => e)).kind).toBe(
      "failed",
    );
  });
});
