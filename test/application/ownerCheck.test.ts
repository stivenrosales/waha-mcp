import { describe, expect, it } from "vitest";
import { createOwnerCheck } from "../../src/application/ownerCheck.js";
import { InMemoryWahaGateway } from "../fakes/InMemoryWahaGateway.js";

function record(initial: string | null) {
  let owner = initial;
  const resets: string[] = [];
  return {
    resets,
    getOwner: () => owner,
    resetForOwner: (o: string) => {
      resets.push(o);
      owner = o;
    },
  };
}

describe("createOwnerCheck", () => {
  it("wipes once when the recorded owner differs, then never asks WAHA again", async () => {
    const waha = new InMemoryWahaGateway({ me: { id: "1@c.us", lid: null } });
    const store = record("default|2@c.us");
    const check = createOwnerCheck(waha, store, "default");
    await Promise.all([check(), check()]);
    await check();
    expect(store.resets).toEqual(["default|1@c.us"]);
    expect(waha.count("getMe")).toBe(1);
  });

  it("keeps the store when the owner matches", async () => {
    const waha = new InMemoryWahaGateway({ me: { id: "1@c.us", lid: null } });
    const store = record("default|1@c.us");
    await createOwnerCheck(waha, store, "default")();
    expect(store.resets).toEqual([]);
  });

  it("rejects while getMe fails and retries on the next call", async () => {
    const data: { failWith?: Error } = { failWith: new Error("down") };
    const waha = new InMemoryWahaGateway(data);
    const store = record(null);
    const check = createOwnerCheck(waha, store, "default");
    await expect(check()).rejects.toThrow("down");
    expect(store.resets).toEqual([]);
    delete data.failWith;
    await check();
    expect(store.resets).toHaveLength(1);
  });
});
