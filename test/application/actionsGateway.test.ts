import { describe, expect, it } from "vitest";
import { withMessageActions } from "../../src/application/actionsGateway.js";
import { createSqliteMessageActionStore } from "../../src/infrastructure/cache/sqliteMessageActionStore.js";
import { openCacheDatabase } from "../../src/infrastructure/cache/sqliteMessageStore.js";
import { getEngineMapper } from "../../src/infrastructure/waha/engines/index.js";
import { InMemoryWahaGateway, rawText } from "../fakes/InMemoryWahaGateway.js";
import { testCipher } from "../fakes/testCipher.js";

const m = getEngineMapper("GOWS");
const CHAT = "100000000000009@g.us";

function setup(messages: Record<string, unknown>[]) {
  const waha = new InMemoryWahaGateway({ messages: { [CHAT]: messages } });
  const store = createSqliteMessageActionStore(openCacheDatabase(":memory:"), testCipher());
  let ownerChecks = 0;
  const gw = withMessageActions(waha, {
    store,
    mapper: async () => m,
    ensureOwner: async () => {
      ownerChecks++;
    },
  });
  return { waha, store, gw, ownerChecks: () => ownerChecks };
}

describe("withMessageActions", () => {
  it("revoked rows come back deleted from getMessages and getMessage", async () => {
    const raw = rawText("R1", 100, "secret words");
    const { store, gw } = setup([raw]);
    store.putOverride("R1", { kind: "revoked", at: 200 });
    const page = await gw.getMessages(CHAT, { limit: 10, offset: 0 });
    const one = await gw.getMessage(CHAT, raw.id as string);
    for (const r of [page[0], one]) {
      expect(m.message(r).type).toBe("deleted");
      expect(JSON.stringify(r)).not.toContain("secret");
    }
  });

  it("edited rows come back with the new text and edited", async () => {
    const raw = rawText("E1", 100, "before");
    const { store, gw } = setup([raw]);
    store.putOverride("E1", { kind: "edited", text: "after", at: 200 });
    const page = await gw.getMessages(CHAT, { limit: 10, offset: 0 });
    const one = await gw.getMessage(CHAT, raw.id as string);
    for (const r of [page[0], one]) {
      const msg = m.message(r);
      expect(msg.text).toBe("after");
      expect(msg.edited).toBe(true);
      expect(JSON.stringify(r)).not.toContain("before");
    }
  });

  it("rows without overrides are untouched (same object)", async () => {
    const a = rawText("A1", 100, "a");
    const b = rawText("B1", 90, "b");
    const { store, gw } = setup([a, b]);
    store.putOverride("A1", { kind: "revoked", at: 200 });
    const page = await gw.getMessages(CHAT, { limit: 10, offset: 0 });
    expect(page[1]).toBe(b);
    expect(page[0]).not.toBe(a);
    const plain = setup([b]);
    const untouched = await plain.gw.getMessages(CHAT, { limit: 10, offset: 0 });
    expect(untouched[0]).toBe(b);
    expect(await plain.gw.getMessage(CHAT, b.id as string)).toBe(b);
  });

  it("storedReactions returns the stored map", () => {
    const { store, gw } = setup([]);
    store.putReaction({ messageId: "X1", reactor: "a@lid", emoji: "👍", ts: 1 });
    expect(gw.storedReactions?.(["X1", "X2"])).toEqual(
      new Map([["X1", [{ emoji: "👍", by: "a@lid" }]]]),
    );
  });

  it("checks the owner before reading the store", async () => {
    const { gw, ownerChecks } = setup([rawText("A1", 100, "a")]);
    await gw.getMessages(CHAT, { limit: 10, offset: 0 });
    expect(ownerChecks()).toBe(1);
  });
});
