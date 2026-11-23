import { describe, expect, it, vi } from "vitest";
import { guardUnknownSends } from "../../src/application/sendGuard.js";
import { SendOutcomeUnknownError } from "../../src/domain/errors.js";
import type { WahaGateway } from "../../src/domain/ports/WahaGateway.js";
import type { WhatsAppSender } from "../../src/domain/ports/WhatsAppSender.js";

const CHAT = "51999@c.us";
const T0 = 1_700_000_000_000;

function setup(opts: { history?: unknown[]; historyFails?: boolean } = {}) {
  let now = T0;
  const sendText = vi.fn<WhatsAppSender["sendText"]>();
  const getMessages = vi.fn(async () => {
    if (opts.historyFails) throw new Error("WAHA down");
    return opts.history ?? [];
  });
  const inner = { sendText } as unknown as WhatsAppSender;
  const gateway = { getMessages } as unknown as Pick<WahaGateway, "getMessages">;
  const guarded = guardUnknownSends(inner, { gateway, now: () => now, windowMs: 600_000 });
  return { guarded, sendText, getMessages, advance: (ms: number) => (now += ms) };
}

describe("guardUnknownSends", () => {
  it("does not send a repeat when the first send with unknown outcome reached the chat", async () => {
    const { guarded, sendText, advance } = setup({
      history: [
        { id: "true_51999@c.us_ABC", fromMe: true, body: "hola", timestamp: T0 / 1000 + 1 },
      ],
    });
    sendText.mockRejectedValueOnce(new SendOutcomeUnknownError());
    await expect(guarded.sendText({ chatId: CHAT, text: "hola" })).rejects.toThrow(
      SendOutcomeUnknownError,
    );
    advance(30_000);
    const result = await guarded.sendText({ chatId: CHAT, text: "hola" });
    expect(result).toEqual({
      id: "true_51999@c.us_ABC",
      timestamp: T0 / 1000 + 1,
      alreadySent: true,
    });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("sends the repeat when the first send did not reach the chat", async () => {
    const { guarded, sendText, getMessages } = setup({
      history: [{ id: "x", fromMe: false, body: "hola", timestamp: T0 / 1000 + 1 }],
    });
    sendText.mockRejectedValueOnce(new SendOutcomeUnknownError());
    sendText.mockResolvedValueOnce({ id: "NEW", timestamp: 1 });
    await expect(guarded.sendText({ chatId: CHAT, text: "hola" })).rejects.toThrow();
    expect(await guarded.sendText({ chatId: CHAT, text: "hola" })).toEqual({
      id: "NEW",
      timestamp: 1,
    });
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("refuses the repeat while the chat cannot be checked, and sends nothing", async () => {
    const { guarded, sendText } = setup({ historyFails: true });
    sendText.mockRejectedValueOnce(new SendOutcomeUnknownError());
    await expect(guarded.sendText({ chatId: CHAT, text: "hola" })).rejects.toThrow();
    await expect(guarded.sendText({ chatId: CHAT, text: "hola" })).rejects.toThrow(
      SendOutcomeUnknownError,
    );
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("does not check the chat for a different text, another chat, or after the window", async () => {
    const { guarded, sendText, getMessages, advance } = setup();
    sendText.mockRejectedValueOnce(new SendOutcomeUnknownError());
    sendText.mockResolvedValue({ id: "OK", timestamp: 1 });
    await expect(guarded.sendText({ chatId: CHAT, text: "hola" })).rejects.toThrow();
    await guarded.sendText({ chatId: CHAT, text: "otra cosa" });
    await guarded.sendText({ chatId: "52000@c.us", text: "hola" });
    advance(600_001);
    await guarded.sendText({ chatId: CHAT, text: "hola" });
    expect(getMessages).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(4);
  });

  it("keeps a confirmed send and other sender methods unchanged", async () => {
    const { guarded, sendText, getMessages } = setup();
    sendText.mockResolvedValue({ id: "OK", timestamp: 1 });
    expect(await guarded.sendText({ chatId: CHAT, text: "hola" })).toEqual({
      id: "OK",
      timestamp: 1,
    });
    expect(await guarded.sendText({ chatId: CHAT, text: "hola" })).toEqual({
      id: "OK",
      timestamp: 1,
    });
    expect(getMessages).not.toHaveBeenCalled();
  });
});
