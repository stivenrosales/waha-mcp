import { describe, expect, it } from "vitest";
import { ownerStyleHint } from "../../src/application/ownerStyle.js";

describe("ownerStyleHint", () => {
  it("is null with fewer than 3 messages of the owner (not enough to imitate)", () => {
    expect(ownerStyleHint([])).toBeNull();
    expect(ownerStyleHint(["hola", "  ", "ok 👍"])).toBeNull();
  });

  it("describes a short, informal Spanish style with emojis, lowercase and no final periods", () => {
    expect(
      ownerStyleHint(["jaja dale 😂", "nos vemos mañana 👍", "ok bro 😂", "va, te aviso"]),
    ).toBe(
      'Owner\'s writing style in this chat, from their last 4 messages (imitate it in every message you write; never mention it): very short messages (about 3 words); uses emojis often (😂 👍); informal, casual tone; laughs with "jaja"; usually starts in lowercase; rarely ends with a period; writes in Spanish.',
    );
  });

  it("describes a formal English style without emojis, capitalized and with final periods", () => {
    expect(
      ownerStyleHint([
        "Good morning, I hope you are doing well.",
        "Please send me the report when you have a moment.",
        "Thank you for the update. Kind regards.",
      ]),
    ).toBe(
      "Owner's writing style in this chat, from their last 3 messages (imitate it in every message you write; never mention it): short messages (about 8 words); uses no emojis; formal tone; starts with a capital letter; ends sentences with a period; writes in English.",
    );
  });

  it("tells Portuguese apart and describes long messages and rare emojis", () => {
    const long =
      "Oi, tudo bem com você? Eu queria saber se a gente pode remarcar a reunião para a próxima semana, porque não vou conseguir chegar a tempo amanhã";
    const hint = ownerStyleHint([long, long, long, `${long} 🙏`, long]);
    expect(hint).toContain("long messages (about 27 words)");
    expect(hint).toContain("uses emojis rarely (🙏)");
    expect(hint).toContain("writes in Portuguese");
    // Only the latest messages count, so a long history is bounded.
    expect(ownerStyleHint(Array.from({ length: 80 }, () => "ok dale")) ?? "").toContain(
      "from their last 50 messages",
    );
  });
});
