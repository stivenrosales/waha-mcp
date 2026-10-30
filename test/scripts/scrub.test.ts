import { describe, expect, it } from "vitest";
import { scrubFixture } from "../../scripts/scrub.js";

describe("scrubFixture", () => {
  it("replaces phones and JIDs consistently", () => {
    const out = scrubFixture({
      from: "51987654321@c.us",
      author: "51987654321@c.us",
      to: "120363012345678901@g.us",
      participant: "51912345678@s.whatsapp.net",
    }) as Record<string, string>;
    expect(out.from).toBe(out.author);
    expect(out.from).toMatch(/^\d{11}@c\.us$/);
    expect(out.to).toMatch(/^\d{18}@g\.us$/);
    expect(out.participant).toMatch(/^\d{11}@s\.whatsapp\.net$/);
    expect(out.participant).not.toBe(out.from);
    expect(JSON.stringify(out)).not.toContain("51987654321");
    expect(JSON.stringify(out)).not.toContain("51912345678");
  });

  it("replaces phones embedded in longer strings and in object keys", () => {
    const out = scrubFixture({ id: "false_120363012345678901@g.us_3EB0AA", "51987654321@c.us": 1 });
    expect(JSON.stringify(out)).not.toMatch(/120363012345678901|51987654321/);
    expect(JSON.stringify(out)).not.toContain("901@g.us");
    expect((out as Record<string, unknown>).id).toMatch(/^false_\d{18}@g\.us_3EB0AA$/);
  });

  it("redacts name and text fields but keeps keys", () => {
    const out = scrubFixture({
      pushName: "Maria",
      name: "Maria",
      subject: "Family",
      notifyName: "M",
      Name: "Group",
      Topic: "Topic",
      description: "desc",
      body: "hello world",
      caption: "cap",
      text: "txt",
      conversation: "conv",
      filename: "secret.pdf",
      nested: [{ body: "again" }],
    }) as Record<string, unknown>;
    for (const key of [
      "pushName",
      "name",
      "subject",
      "notifyName",
      "Name",
      "Topic",
      "description",
      "body",
      "caption",
      "text",
      "conversation",
      "filename",
    ]) {
      expect(out[key]).toMatch(/^<redacted-\d+>$/);
    }
    expect(out.pushName).toBe(out.name);
    expect(out.body).not.toBe(out.caption);
    expect((out.nested as { body: string }[])[0]?.body).toMatch(/^<redacted-\d+>$/);
  });

  it("replaces base64 blobs and urls but keeps the fields", () => {
    const out = scrubFixture({
      jpegThumbnail: "A".repeat(120),
      url: "https://mmg.whatsapp.net/secret?x=1",
      mediaKey: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123=",
    }) as Record<string, string>;
    expect(out.jpegThumbnail).toBe("<base64>");
    expect(out.url).toBe("<url>");
    expect(out.mediaKey).toBe("<base64>");
  });

  it("keeps timestamps, types and booleans", () => {
    const input = {
      timestamp: 1700000000,
      fromMe: true,
      hasMedia: false,
      ack: 3,
      x: null,
      type: "image",
    };
    expect(scrubFixture(input)).toEqual(input);
  });

  it("keeps reply links", () => {
    const out = scrubFixture([
      { id: "false_51987654321@c.us_AAA", body: "q" },
      { id: "true_51911111111@c.us_BBB", replyTo: { id: "false_51987654321@c.us_AAA" } },
    ]) as { id: string; replyTo?: { id: string } }[];
    expect(out[1]?.replyTo?.id).toBe(out[0]?.id);
  });

  it("fakes device JIDs and keeps the device suffix", () => {
    const out = scrubFixture({ participant: "51987654321:12@s.whatsapp.net" }) as {
      participant: string;
    };
    expect(out.participant).toMatch(/^\d{11}:12@s\.whatsapp\.net$/);
    expect(out.participant).not.toContain("51987654321");
  });

  it("keeps 18-digit group ids whole (no tail leak)", () => {
    const out = JSON.stringify(scrubFixture({ id: "120363012345678901@g.us" }));
    expect(out).toMatch(/"\d{18}@g\.us"/);
    expect(out).not.toContain("901@g.us");
  });

  it("redacts vcard content and unlisted string fields (fail closed)", () => {
    const out = JSON.stringify(
      scrubFixture({
        vcard: "BEGIN:VCARD\nFN:Maria Perez\nTEL:+51 987 654 321\nEND:VCARD",
        displayName: "Maria",
        fileName: "contract.pdf",
        title: "Cafe Central",
        address: "Av. Siempre Viva 742",
        optionName: "Yes please",
        somethingNew: "unknown field",
        URL: "https://example.com/private",
      }),
    );
    for (const leak of [
      "Maria",
      "987",
      "contract",
      "Cafe",
      "Siempre",
      "Yes please",
      "unknown",
      "example.com",
    ]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain("fileName");
    expect(out).toContain('"URL":"<url>"');
  });

  it("rounds coordinates", () => {
    const out = scrubFixture({
      locationMessage: { degreesLatitude: -12.046374, degreesLongitude: -77.042793 },
    }) as { locationMessage: Record<string, number> };
    expect(out.locationMessage).toEqual({ degreesLatitude: -12, degreesLongitude: -77 });
  });

  it("matches keys case-insensitively", () => {
    const out = scrubFixture({
      PushName: "A",
      BODY: "b",
      Filename: "c",
      Mimetype: "image/png",
    }) as Record<string, string>;
    expect(out.PushName).toMatch(/^<redacted/);
    expect(out.BODY).toMatch(/^<redacted/);
    expect(out.Filename).toMatch(/^<redacted/);
    expect(out.Mimetype).toBe("image/png");
  });

  it("maps the same JID identically across separate calls", () => {
    const a = scrubFixture({ id: "51955500011@c.us" }) as { id: string };
    const b = scrubFixture([{ participant: "51955500011@c.us" }]) as { participant: string }[];
    expect(b[0]?.participant).toBe(a.id);
  });

  it("refuses to return output that still holds an identifier", () => {
    expect(() => scrubFixture({ id: "status@c.us" })).toThrow(/JID/);
    expect(() => scrubFixture({ id: "x@lid" })).toThrow(/JID/);
  });
});
