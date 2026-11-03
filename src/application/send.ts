import { InvalidInputError } from "../domain/errors.js";

/** WhatsApp's own limit for one text message. */
export const MAX_TEXT_CHARS = 65536;

/** Each mentioned id's user part (`51999` of `51999@c.us`) must appear as `@51999` in the text. */
export function assertMentions(text: string, mentions: string[]): void {
  for (const id of mentions) {
    const user = id.split("@")[0] ?? "";
    const tagged = new RegExp(`@${user.replace(/[^0-9A-Za-z]/g, "")}(?![0-9A-Za-z])`);
    if (!user || !tagged.test(text))
      throw new InvalidInputError(`Mention @${user} is not in the text.`);
  }
}

export function assertTextLength(text: string): void {
  if (text.length > MAX_TEXT_CHARS)
    throw new InvalidInputError(
      `The message is ${text.length} characters long; WhatsApp allows ${MAX_TEXT_CHARS}.`,
    );
}
