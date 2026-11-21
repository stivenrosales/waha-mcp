import { describe, expect, it } from "vitest";
import { InvalidInputError } from "../../src/domain/errors.js";
import { parseMessageId, shortMessageId } from "../../src/domain/messageId.js";

describe("parseMessageId", () => {
  it("parses a direct id", () => {
    expect(parseMessageId("true_51999888777@c.us_3EB0ABC")).toMatchObject({
      id: "true_51999888777@c.us_3EB0ABC",
      fromMe: true,
      chatId: "51999888777@c.us",
      shortId: "3EB0ABC",
      participant: null,
    });
  });

  it("parses a group id with participant", () => {
    expect(parseMessageId("false_123-456@g.us_AAA_51911@c.us")).toMatchObject({
      fromMe: false,
      chatId: "123-456@g.us",
      shortId: "AAA",
      participant: "51911@c.us",
    });
    expect(parseMessageId("false_123@g.us_AAA_9@lid").participant).toBe("9@lid");
    expect(parseMessageId("true_55@lid_AAA").chatId).toBe("55@lid");
  });

  it.each([
    "",
    "3EB0ABC",
    "maybe_x@c.us_A",
    "true_nochat_A",
    "true_x@c.us_",
    "true_x@c.us_A_b@c.us_extra",
    "true_x@c.us_A_nope",
  ])("rejects %j", (bad) => {
    expect(() => parseMessageId(bad)).toThrow(InvalidInputError);
  });
});

describe("shortMessageId", () => {
  it("extracts the stable id", () => {
    expect(shortMessageId("true_51999@c.us_3EB0ABC")).toBe("3EB0ABC");
    expect(shortMessageId("false_1@g.us_AAA_9@lid")).toBe("AAA");
  });

  it("returns anything else unchanged", () => {
    expect(shortMessageId("3EB0ABC")).toBe("3EB0ABC");
    expect(shortMessageId("true_x")).toBe("true_x");
    expect(shortMessageId("")).toBe("");
  });
});
