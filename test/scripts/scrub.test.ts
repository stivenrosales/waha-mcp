import { describe, expect, it } from "vitest";
import { scrubFixture } from "../../scripts/scrub.js";

describe("scrubFixture", () => {
  it("replaces phones and JIDs consistently", () => {
    const out = scrubFixture({
      from: "51987654321@c.us",
      author: "51987654321@c.us",
      group: "120363012345678901@g.us",
      other: "51912345678@s.whatsapp.net",
    }) as Record<string, string>;
    expect(out.from).toBe(out.author);
    expect(out.from).toMatch(/^\d{11}@c\.us$/);
    expect(out.group).toMatch(/^\d{18}@g\.us$/);
    expect(out.other).toMatch(/^\d{11}@s\.whatsapp\.net$/);
    expect(out.other).not.toBe(out.from);
    expect(JSON.stringify(out)).not.toContain("51987654321");
    expect(JSON.stringify(out)).not.toContain("51912345678");
  });

  it("replaces phones embedded in longer strings and in object keys", () => {
    const out = scrubFixture({ id: "false_120363012345678901@g.us_3EB0AA", "51987654321@c.us": 1 });
    expect(JSON.stringify(out)).not.toMatch(/120363012345678901|51987654321/);
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
});
