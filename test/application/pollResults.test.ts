import { describe, expect, it } from "vitest";
import { getPollResults } from "../../src/application/pollResults.js";
import { InvalidInputError } from "../../src/domain/errors.js";
import type { StoredVote } from "../../src/domain/ports/MessageActionStore.js";
import { gowsMapper } from "../../src/infrastructure/waha/engines/gows.js";
import { rawText } from "../fakes/InMemoryWahaGateway.js";
import { ANA, BOB, GROUP_A, gateway, ME_PHONE, type Raw } from "./helpers.js";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const POLL_ID = "3EB0POLL";
const MSG_ID = `true_${GROUP_A}_${POLL_ID}`;

const pollRaw = (id = POLL_ID): Raw => ({
  ...rawText(id, 1000, "", { chat: GROUP_A }),
  id: `true_${GROUP_A}_${id}`,
  fromMe: true,
  _data: {
    Info: { Sender: "100000000000002:5@lid", PushName: null },
    Message: {
      pollCreationMessageV3: {
        name: "Lunch?",
        options: [{ optionName: "Yes" }, { optionName: "No" }, { optionName: "Maybe" }],
      },
    },
  },
});

const vote = (voter: string, options: string[], ts: number): StoredVote => ({
  pollId: POLL_ID,
  voter,
  options,
  ts,
});

function setup(votes: StoredVote[], failed = 0, extra: Raw[] = []) {
  const gw = gateway({
    messages: { [GROUP_A]: [pollRaw(), ...extra] },
    contacts: [
      { id: ANA, name: "Ana Pérez", pushname: "" },
      { id: BOB, name: "", pushname: "Bob" },
      { id: ME_PHONE, name: "", pushname: "Yo" },
    ],
  });
  const actions = { pollVotes: async () => ({ votes, failed }) };
  const run = (webhooksOn = true, id = MSG_ID) =>
    getPollResults(
      { gateway: gw, mapper: gowsMapper, actions: actions as never, webhooksOn, now: () => NOW },
      id,
    );
  return { run, gw };
}

describe("getPollResults", () => {
  it("counts votes per option in poll order", async () => {
    const { run } = setup([
      vote(ANA, ["Yes"], 10),
      vote(BOB, ["No"], 11),
      vote("x@c.us", ["Yes"], 12),
    ]);
    const r = await run();
    expect(r.question).toBe("Lunch?");
    expect(r.options).toEqual([
      { option: "Yes", votes: 2 },
      { option: "No", votes: 1 },
      { option: "Maybe", votes: 0 },
    ]);
    expect(r.webhooks).toBe(true);
    expect(r.failedVotes).toBe(0);
  });

  it("counts a multiple-answer voter once per option and lists a stray option uncounted", async () => {
    const { run } = setup([vote(ANA, ["Yes", "Maybe", "Gone"], 10)]);
    const r = await run();
    expect(r.options.map((o) => o.votes)).toEqual([1, 0, 1]);
    expect(r.voters).toEqual([{ id: ANA, name: "Ana Pérez", options: ["Yes", "Maybe", "Gone"] }]);
  });

  it("lists voters newest first and skips voters who cleared their vote", async () => {
    const { run } = setup([vote(ANA, ["Yes"], 10), vote(BOB, ["No"], 20), vote("z@c.us", [], 30)]);
    const r = await run();
    expect(r.voters.map((v) => v.id)).toEqual([BOB, ANA]);
  });

  it("names voters from contacts, joining @c.us and @s.whatsapp.net, and resolves the owner", async () => {
    const { run } = setup([
      vote("51999000111@s.whatsapp.net", ["Yes"], 10),
      vote(BOB, ["No"], 11),
      vote("me", ["Yes"], 12),
      vote("999@lid", ["No"], 13),
    ]);
    const r = await run();
    expect(r.voters).toEqual([
      { id: "999@lid", name: null, options: ["No"] },
      { id: "me", name: "Yo", options: ["Yes"] },
      { id: BOB, name: "Bob", options: ["No"] },
      { id: "51999000111@s.whatsapp.net", name: "Ana Pérez", options: ["Yes"] },
    ]);
  });

  it("reports failed votes", async () => {
    const { run } = setup([vote(ANA, ["Yes"], 10)], 2);
    expect((await run()).failedVotes).toBe(2);
  });

  it("rejects a message that is not a poll", async () => {
    const text = { ...rawText("T1", 5, "hi", { chat: GROUP_A }), id: `true_${GROUP_A}_T1` };
    const { run } = setup([], 0, [text]);
    await expect(run(true, `true_${GROUP_A}_T1`)).rejects.toThrow(
      new InvalidInputError("That message is not a poll."),
    );
  });

  it("a deleted poll message is not a poll", async () => {
    const gw = gateway({
      messages: {
        [GROUP_A]: [gowsMapper.revokedPayload(pollRaw()) as Raw],
      },
    });
    const actions = { pollVotes: async () => ({ votes: [], failed: 0 }) };
    await expect(
      getPollResults(
        {
          gateway: gw,
          mapper: gowsMapper,
          actions: actions as never,
          webhooksOn: true,
          now: () => NOW,
        },
        MSG_ID,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("without webhooks returns zero counts and never reads votes", async () => {
    const gw = gateway({ messages: { [GROUP_A]: [pollRaw()] } });
    const actions = {
      pollVotes: async () => {
        throw new Error("must not be called");
      },
    };
    const r = await getPollResults(
      {
        gateway: gw,
        mapper: gowsMapper,
        actions: actions as never,
        webhooksOn: false,
        now: () => NOW,
      },
      MSG_ID,
    );
    expect(r).toEqual({
      question: "Lunch?",
      options: [
        { option: "Yes", votes: 0 },
        { option: "No", votes: 0 },
        { option: "Maybe", votes: 0 },
      ],
      voters: [],
      failedVotes: 0,
      webhooks: false,
    });
  });
});
