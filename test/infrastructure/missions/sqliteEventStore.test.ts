import { describe, expect, it } from "vitest";
import { openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createSqliteEventStore } from "../../../src/infrastructure/missions/sqliteEventStore.js";

const event = (eventId: string, tenantId = "t1") => ({
  tenantId,
  eventId,
  kind: "message" as const,
  receivedAt: "2026-11-17T10:00:00.000Z",
  payloadSealed: `sealed-${eventId}`,
});

describe("sqliteEventStore", () => {
  it("stores an event once per tenant and event id", () => {
    const store = createSqliteEventStore(openAuthDatabase(":memory:"));
    expect(store.put(event("evt_1"))).toBe("stored");
    expect(store.put({ ...event("evt_1"), payloadSealed: "other" })).toBe("duplicate");
    // The same WAHA id in another tenant is a different event.
    expect(store.put(event("evt_1", "t2"))).toBe("stored");
    const pending = store.pending(10);
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject(event("evt_1"));
  });

  it("lists pending events oldest first, up to the limit, and forgets payloads when done", () => {
    const db = openAuthDatabase(":memory:");
    const store = createSqliteEventStore(db);
    store.put(event("evt_a"));
    store.put(event("evt_b"));
    store.put(event("evt_c"));
    const [first, second] = store.pending(2);
    expect([first?.eventId, second?.eventId]).toEqual(["evt_a", "evt_b"]);
    store.markDone(first?.id as number);
    expect(store.pending(10).map((e) => e.eventId)).toEqual(["evt_b", "evt_c"]);
    // Done events keep their id (dedupe) but not their content.
    expect(store.put(event("evt_a"))).toBe("duplicate");
    const row = db
      .prepare("SELECT payload_sealed FROM webhook_events WHERE event_id = 'evt_a'")
      .get() as { payload_sealed: string };
    expect(row.payload_sealed).toBe("");
  });

  it("opening twice over the same database keeps the rows (idempotent schema)", () => {
    const db = openAuthDatabase(":memory:");
    createSqliteEventStore(db).put(event("evt_1"));
    expect(createSqliteEventStore(db).pending(10)).toHaveLength(1);
  });
});
