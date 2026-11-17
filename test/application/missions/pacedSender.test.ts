import { describe, expect, it } from "vitest";
import { sendPaced } from "../../../src/application/missions/pacedSender.js";
import { SendOutcomeUnknownError } from "../../../src/domain/errors.js";
import { typingDelayMs } from "../../../src/domain/missions/pacing.js";
import { RecordingSender } from "../../fakes/InMemoryWahaGateway.js";

const CHAT = "5511@c.us";

function setup() {
  const sender = new RecordingSender();
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
    sender.calls.push({ method: "sleep", args: ms });
  };
  return { sender, slept, deps: { sender, sleep, rand: () => 0.5 } };
}

describe("sendPaced", () => {
  it("runs seen, typing, a computed pause, stop typing, then the text", async () => {
    const { sender, slept, deps } = setup();
    const sent = await sendPaced(deps, {
      chatId: CHAT,
      text: "Hola, ¿cómo estás?",
      seenIds: ["m1", "m2"],
    });
    expect(sender.calls.map((c) => c.method)).toEqual([
      "sendSeen",
      "startTyping",
      "sleep",
      "stopTyping",
      "sendText",
    ]);
    expect(sender.calls[0]?.args).toEqual({ chatId: CHAT, messageIds: ["m1", "m2"] });
    expect(slept).toEqual([typingDelayMs("Hola, ¿cómo estás?", () => 0.5)]);
    expect(sender.calls[4]?.args).toEqual({ chatId: CHAT, text: "Hola, ¿cómo estás?" });
    expect(sent?.id).toBeTruthy();
  });

  it("sends nothing when cancelled during the typing pause", async () => {
    const { sender, deps } = setup();
    let cancelled = false;
    const sent = await sendPaced(
      {
        ...deps,
        sleep: async () => {
          cancelled = true;
        },
      },
      { chatId: CHAT, text: "hola", seenIds: [], cancelled: () => cancelled },
    );
    expect(sent).toBeNull();
    expect(sender.calls.map((c) => c.method)).toEqual(["startTyping", "stopTyping"]);
  });

  it("skips sendSeen when there is nothing to mark", async () => {
    const { sender, deps } = setup();
    await sendPaced(deps, { chatId: CHAT, text: "hola", seenIds: [] });
    expect(sender.calls.map((c) => c.method)).toEqual([
      "startTyping",
      "sleep",
      "stopTyping",
      "sendText",
    ]);
  });

  it("still sends when seen, startTyping or stopTyping fail", async () => {
    for (const failing of ["sendSeen", "startTyping", "stopTyping"]) {
      const { sender, deps } = setup();
      sender.failMethods[failing] = new Error("boom");
      await sendPaced(deps, { chatId: CHAT, text: "hola", seenIds: ["m1"] });
      expect(sender.calls.at(-1)?.method).toBe("sendText");
    }
  });

  it("propagates a sendText failure unchanged and does not retry", async () => {
    const { sender, deps } = setup();
    const err = new SendOutcomeUnknownError();
    sender.failMethods.sendText = err;
    await expect(sendPaced(deps, { chatId: CHAT, text: "hola", seenIds: [] })).rejects.toBe(err);
    expect(sender.calls.filter((c) => c.method === "sendText")).toHaveLength(0);
  });
});
