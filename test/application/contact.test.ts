import { describe, expect, it } from "vitest";
import { getContact } from "../../src/application/contact.js";
import { InvalidInputError, WahaUnavailableError } from "../../src/domain/errors.js";
import { gowsMapper } from "../../src/infrastructure/waha/engines/gows.js";
import type { InMemoryData, InMemoryWahaGateway } from "../fakes/InMemoryWahaGateway.js";
import { ANA, BOB, chat, GROUP_A, GROUP_B, gateway } from "./helpers.js";

const ANA_LID = "100000000000111@lid";
const NOW = Date.parse("2026-10-30T15:00:00Z");
const nowSec = NOW / 1000;
const deps = { now: () => NOW };
const run = (gw: InMemoryWahaGateway, q: Parameters<typeof getContact>[2]) =>
  getContact(gw, gowsMapper, q, deps);

const member = (jid: string, phone: string | null, lid: string | null) => ({
  JID: jid,
  PhoneNumber: phone,
  LID: lid,
  IsAdmin: false,
});

const data = (): InMemoryData => ({
  chats: [
    chat(ANA, nowSec - 5000, null),
    chat(ANA_LID, nowSec - 100, null),
    chat(BOB, nowSec - 9000, null),
  ],
  contacts: [
    { id: ANA, name: "Ana Pérez", pushname: "anita" },
    { id: { _serialized: BOB }, name: "", pushname: "Bob" },
    { id: "51999000333@c.us", name: "Ana María", pushname: "" },
  ],
  groups: [
    { JID: GROUP_A, Name: "Equipo", Participants: [member(ANA_LID, `${ANA}`, ANA_LID)] },
    { JID: GROUP_B, Name: "Familia", Participants: [member(BOB, null, null)] },
    { JID: "100000000000003@g.us", Name: "Otros", Participants: [member(ANA_LID, null, ANA_LID)] },
  ],
  lids: { [ANA_LID]: ANA },
});

describe("getContact", () => {
  it("requires exactly one of contactId, phone or name", async () => {
    const gw = gateway(data());
    await expect(run(gw, {})).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { phone: "51999000111", name: "Ana" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(run(gw, { contactId: ANA, phone: "51999000111" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(run(gw, { name: "  " })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { phone: "abc" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { contactId: GROUP_A })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("resolves a phone (normalized), its lid, names, shared groups and last interaction", async () => {
    const gw = gateway(data());
    const r = await run(gw, { phone: "+51 999 000 111" });
    expect(r.match).toBe("unique");
    expect(r.contact).toEqual({
      id: ANA,
      lid: ANA_LID,
      phone: "51999000111",
      name: "Ana Pérez",
      pushname: "anita",
      groupsInCommon: [
        { id: GROUP_A, name: "Equipo" },
        { id: "100000000000003@g.us", name: "Otros" },
      ],
      lastInteraction: new Date((nowSec - 100) * 1000).toISOString(),
    });
    // Phone input never needs the lid endpoint: the lid comes from group participants.
    expect(gw.count("lookupLid")).toBe(0);
  });

  it("a lid id gets its phone through lookupLid and the same result", async () => {
    const gw = gateway(data());
    const r = await run(gw, { contactId: ANA_LID });
    expect(gw.count("lookupLid")).toBe(1);
    expect(r.contact).toMatchObject({
      id: ANA,
      lid: ANA_LID,
      phone: "51999000111",
      name: "Ana Pérez",
    });
    expect(r.contact?.groupsInCommon).toHaveLength(2);
  });

  it("a failing lid lookup is not fatal", async () => {
    const lidOnly = {
      groups: [{ JID: GROUP_A, Name: "Equipo", Participants: [member(ANA_LID, null, ANA_LID)] }],
    };
    const gw = gateway({ ...data(), ...lidOnly, lids: undefined });
    const r = await run(gw, { contactId: ANA_LID });
    expect(r.contact).toMatchObject({ id: ANA_LID, lid: ANA_LID, phone: null });
    // Still matched in groups and chats by lid.
    expect(r.contact?.groupsInCommon).toEqual([{ id: GROUP_A, name: "Equipo" }]);
    expect(r.contact?.lastInteraction).not.toBeNull();
    const broken = gateway({ ...data(), ...lidOnly });
    broken.lookupLid = async () => {
      throw new WahaUnavailableError("down");
    };
    expect((await run(broken, { contactId: ANA_LID })).contact).toMatchObject({ phone: null });
  });

  it("learns a missing phone from group participants when the lookup has no answer", async () => {
    const r = await run(gateway({ ...data(), lids: undefined }), { contactId: ANA_LID });
    expect(r.contact).toMatchObject({ id: ANA, phone: "51999000111", name: "Ana Pérez" });
  });

  it("an unknown phone still answers, with no names and no interaction", async () => {
    const r = await run(gateway(data()), { phone: "51000111222" });
    expect(r.match).toBe("unique");
    expect(r.contact).toMatchObject({
      id: "51000111222@c.us",
      lid: null,
      name: null,
      pushname: null,
      groupsInCommon: [],
      lastInteraction: null,
    });
  });

  it("searches by name ignoring case and accents; one hit resolves", async () => {
    const r = await run(gateway(data()), { name: "PEREZ" });
    expect(r.match).toBe("unique");
    expect(r.contact?.id).toBe(ANA);
    expect(r.candidates).toEqual([]);
  });

  it("an ambiguous name returns candidates instead of guessing", async () => {
    const r = await run(gateway(data()), { name: "ana" });
    expect(r.match).toBe("ambiguous");
    expect(r.contact).toBeNull();
    expect(r.candidates.map((c) => c.id).sort()).toEqual(["51999000111@c.us", "51999000333@c.us"]);
    expect(r.candidates[0]).toHaveProperty("phone");
  });

  it("caps candidates at 10 and reports the total", async () => {
    const contacts = Array.from({ length: 14 }, (_, i) => ({
      id: `5199900${String(i).padStart(4, "0")}@c.us`,
      name: `Luis ${i}`,
      pushname: "",
    }));
    const r = await run(gateway({ contacts }), { name: "luis" });
    expect(r.candidates).toHaveLength(10);
    expect(r.totalCandidates).toBe(14);
  });

  it("a name with no match says none", async () => {
    const r = await run(gateway(data()), { name: "zzz" });
    expect(r).toMatchObject({ match: "none", contact: null, candidates: [] });
  });

  it("uses the 10-minute contacts cache shared with list_chats", async () => {
    const gw = gateway(data());
    await run(gw, { phone: "51999000111" });
    await run(gw, { name: "bob" });
    expect(gw.count("listContacts")).toBe(2); // one page + the terminating empty page, once
  });
});
