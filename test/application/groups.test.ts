import { describe, expect, it } from "vitest";
import { getGroupInfo, listChats, listGroups } from "../../src/application/groups.js";
import { getEngineMapper } from "../../src/infrastructure/waha/engines/index.js";
import { InMemoryWahaGateway } from "../fakes/InMemoryWahaGateway.js";

const m = getEngineMapper("GOWS");

describe("listGroups", () => {
  const groups = [
    {
      JID: "1@g.us",
      Name: "Family",
      Participants: [{ JID: "a@lid" }],
      GroupCreated: "2024-01-01T00:00:00Z",
    },
    { JID: "2@g.us", Name: "Work Team", Participants: [] },
    { JID: "3@g.us", Name: "Football", Participants: [] },
  ];

  it("filters by nameContains case-insensitively", async () => {
    const gw = new InMemoryWahaGateway({ groups });
    const out = await listGroups(gw, m, { nameContains: "TEAM" });
    expect(out.map((g) => g.id)).toEqual(["2@g.us"]);
    expect((await listGroups(gw, m, {})).length).toBe(3);
  });

  it("sorts by lastActivity desc with unknown activity last", async () => {
    const gw = new InMemoryWahaGateway({
      groups: [
        { JID: "old@g.us", Name: "Old", Participants: [], conversationTimestamp: 100 },
        { JID: "none@g.us", Name: "None", Participants: [] },
        { JID: "new@g.us", Name: "New", Participants: [], conversationTimestamp: 200 },
      ],
    });
    const spy = (raw: unknown) => ({
      ...m.groupSummary(raw),
      lastActivity: (() => {
        const t = (raw as { conversationTimestamp?: number }).conversationTimestamp;
        return t ? new Date(t * 1000).toISOString() : null;
      })(),
    });
    const out = await listGroups(gw, { ...m, groupSummary: spy }, {});
    expect(out.map((g) => g.id)).toEqual(["new@g.us", "old@g.us", "none@g.us"]);
  });
});

describe("listGroups activity from chats", () => {
  const groups = [
    { JID: "a@g.us", Name: "A", Participants: [] },
    { JID: "b@g.us", Name: "B", Participants: [] },
  ];
  it("merges lastActivity from @g.us chats and sorts desc", async () => {
    const gw = new InMemoryWahaGateway({
      groups,
      chats: [
        { id: "a@g.us", conversationTimestamp: 100 },
        { id: "b@g.us", conversationTimestamp: 200 },
        { id: "5@c.us", conversationTimestamp: 999 },
      ],
    });
    const out = await listGroups(gw, m, {});
    expect(out.map((g) => g.id)).toEqual(["b@g.us", "a@g.us"]);
    expect(out[0]?.lastActivity).toBe("1970-01-01T00:03:20.000Z");
  });
  it("still returns the groups when listChats fails", async () => {
    const gw = new InMemoryWahaGateway({ groups });
    gw.listChats = async () => {
      throw new Error("down");
    };
    const out = await listGroups(gw, m, {});
    expect(out.map((g) => g.id)).toEqual(["a@g.us", "b@g.us"]);
    expect(out.every((g) => g.lastActivity === null)).toBe(true);
  });
});

describe("getGroupInfo", () => {
  it("maps the group detail", async () => {
    const gw = new InMemoryWahaGateway({
      groupDetails: {
        "1@g.us": { JID: "1@g.us", Name: "Family", Participants: [{ JID: "a@lid" }] },
      },
    });
    const info = await getGroupInfo(gw, m, "1@g.us");
    expect(info.name).toBe("Family");
    expect(info.participants.map((p) => p.id)).toEqual(["a@lid"]);
  });
});

describe("listChats (direct chats only)", () => {
  const chats = [
    { id: "51911111111@c.us", name: "", conversationTimestamp: 100 },
    { id: { _serialized: "51922222222@c.us" }, name: "Chat Name", conversationTimestamp: 300 },
    { id: "777@lid", name: "", conversationTimestamp: 200 },
    { id: "51933333333@s.whatsapp.net", name: "", conversationTimestamp: 50 },
    { id: "9@g.us", name: "A group", conversationTimestamp: 999 },
    { id: "1@newsletter", name: "News", conversationTimestamp: 999 },
    { id: "1@broadcast", name: "List", conversationTimestamp: 999 },
    { id: "status@broadcast", name: "", conversationTimestamp: 999 },
  ];
  const contacts = [
    { id: "51911111111@c.us", name: "Mum", pushname: "Mother" },
    { id: { _serialized: "51922222222@c.us" }, name: "", pushname: "" },
    { id: "777@lid", name: "", pushname: "Lid Person" },
    { id: "51933333333@c.us", name: "", pushname: "Pushy" },
  ];

  it("returns only direct chats, sorted by lastActivity desc", async () => {
    const gw = new InMemoryWahaGateway({ chats, contacts });
    const out = (await listChats(gw, m, {}, { now: () => 0 })).chats;
    expect(out.map((c) => c.id)).toEqual([
      "51922222222@c.us",
      "777@lid",
      "51911111111@c.us",
      "51933333333@s.whatsapp.net",
    ]);
  });

  it("name precedence: contact.name, contact.pushname, chat.name, null", async () => {
    const gw = new InMemoryWahaGateway({ chats, contacts });
    const out = (await listChats(gw, m, {}, { now: () => 0 })).chats;
    const names = Object.fromEntries(out.map((c) => [c.id, c.name]));
    expect(names).toEqual({
      "51911111111@c.us": "Mum",
      "51922222222@c.us": "Chat Name",
      "777@lid": "Lid Person",
      "51933333333@s.whatsapp.net": "Pushy",
    });
    const gw2 = new InMemoryWahaGateway({ chats: [{ id: "5@c.us", name: "" }], contacts: [] });
    expect((await listChats(gw2, m, {}, { now: () => 0 })).chats[0]?.name).toBeNull();
  });

  it("nameContains is case-insensitive over name and phone", async () => {
    const gw = new InMemoryWahaGateway({ chats, contacts });
    const deps = { now: () => 0 };
    expect((await listChats(gw, m, { nameContains: "mUM" }, deps)).chats.map((c) => c.id)).toEqual([
      "51911111111@c.us",
    ]);
    expect(
      (await listChats(gw, m, { nameContains: "922222" }, deps)).chats.map((c) => c.id),
    ).toEqual(["51922222222@c.us"]);
  });

  it("degrades when contacts fail: chats kept, flag set, failure not cached", async () => {
    const gw = new InMemoryWahaGateway({ chats, contacts });
    let fail = true;
    const orig = gw.listContacts.bind(gw);
    gw.listContacts = async (q) => {
      if (fail) throw new Error("timeout");
      return orig(q);
    };
    const deps = { now: () => 0 };
    const bad = await listChats(gw, m, {}, deps);
    expect(bad.namesResolved).toBe(false);
    expect(bad.chats).toHaveLength(4);
    expect(bad.chats.find((c) => c.id === "51911111111@c.us")?.name).toBeNull();
    expect(bad.chats.find((c) => c.id === "51922222222@c.us")?.name).toBe("Chat Name");
    fail = false;
    const ok = await listChats(gw, m, {}, deps);
    expect(ok.namesResolved).toBe(true);
    expect(ok.chats.find((c) => c.id === "51911111111@c.us")?.name).toBe("Mum");
  });

  it("pages contacts until an empty page and caches them for 10 minutes", async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ id: `c${i}@c.us`, name: `N${i}` }));
    const gw = new InMemoryWahaGateway({ chats, contacts: many });
    let t = 1_000;
    const deps = { now: () => t };
    await listChats(gw, m, {}, deps);
    const first = gw.calls.filter((c) => c.method === "listContacts").map((c) => c.args[0]);
    expect(first).toEqual([
      { limit: 5000, offset: 0 },
      { limit: 5000, offset: 5000 },
      { limit: 5000, offset: 10000 },
    ]);
    t += 9 * 60_000;
    await listChats(gw, m, {}, deps);
    expect(gw.count("listContacts")).toBe(3);
    t += 2 * 60_000;
    await listChats(gw, m, {}, deps);
    expect(gw.count("listContacts")).toBe(6);
  });
});
