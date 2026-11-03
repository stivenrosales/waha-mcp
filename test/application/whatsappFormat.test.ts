import { describe, expect, it } from "vitest";
import { toWhatsAppText } from "../../src/application/whatsappFormat.js";

describe("toWhatsAppText", () => {
  it("turns Markdown bold into WhatsApp bold, leaving __x__ alone", () => {
    expect(toWhatsAppText("**hola** y __mundo__")).toBe("*hola* y __mundo__");
  });

  it("turns Markdown strikethrough into WhatsApp strikethrough", () => {
    expect(toWhatsAppText("~~viejo~~")).toBe("~viejo~");
  });

  it("leaves single-asterisk text alone (it is WhatsApp bold)", () => {
    expect(toWhatsAppText("*ya es negrita*")).toBe("*ya es negrita*");
  });

  it("turns headings of any level into a bold line", () => {
    expect(toWhatsAppText("## Resumen\ntexto")).toBe("*Resumen*\ntexto");
    expect(toWhatsAppText("# Uno\n###### Seis")).toBe("*Uno*\n*Seis*");
    expect(toWhatsAppText("## **Ya negrita**")).toBe("*Ya negrita*");
    expect(toWhatsAppText("#  ")).toBe("#");
  });

  it("turns Markdown links into text and bare URL", () => {
    expect(toWhatsAppText("[Docs](https://a.io)")).toBe("Docs: https://a.io");
    expect(toWhatsAppText("[https://a.io](https://a.io)")).toBe("https://a.io");
  });

  it("flattens tables into one line per row with a bold header", () => {
    expect(toWhatsAppText("| A | B |\n|---|---|\n| 1 | 2 |")).toBe("*A · B*\n1 · 2");
    expect(toWhatsAppText("antes\n| A | B |\n| :-- | --: |\n| 1 | 2 |\ndespués")).toBe(
      "antes\n*A · B*\n1 · 2\ndespués",
    );
  });

  it("removes horizontal rules", () => {
    expect(toWhatsAppText("a\n\n---\n\nb")).toBe("a\n\nb");
    expect(toWhatsAppText("a\n***\nb")).toBe("a\nb");
  });

  it("never touches code fences or inline code", () => {
    expect(toWhatsAppText("```\n**x** # y\n| a | b |\n```")).toBe("```\n**x** # y\n| a | b |\n```");
    expect(toWhatsAppText("usa `**x**` así")).toBe("usa `**x**` así");
    expect(toWhatsAppText("```\na  \n\n\n\nb\n```")).toBe("```\na  \n\n\n\nb\n```");
  });

  it("trims trailing whitespace and collapses 3+ blank lines", () => {
    expect(toWhatsAppText("a  \n\n\n\nb   ")).toBe("a\n\nb");
  });

  it("keeps valid WhatsApp syntax: quotes and lists", () => {
    expect(toWhatsAppText("> cita\n- uno\n* dos\n1. tres")).toBe("> cita\n- uno\n* dos\n1. tres");
  });

  it("keeps accents, ñ and emoji intact", () => {
    expect(toWhatsAppText("Cotización ñandú 🎉 *_ok_*")).toBe("Cotización ñandú 🎉 *_ok_*");
  });

  it("leaves identifiers, URLs and math with double markers alone", () => {
    const url = "See https://docs.python.org/3/reference/datamodel.html#object.__init__";
    expect(toWhatsAppText(url)).toBe(url);
    expect(toWhatsAppText("Override __init__ and __repr__")).toBe("Override __init__ and __repr__");
    expect(toWhatsAppText("Rename it to report__final__v2.pdf")).toBe(
      "Rename it to report__final__v2.pdf",
    );
    expect(toWhatsAppText("a**2 + b**2 = c**2")).toBe("a**2 + b**2 = c**2");
    expect(toWhatsAppText("https://a.io/~~x~~/**y**")).toBe("https://a.io/~~x~~/**y**");
    expect(toWhatsAppText("(**ojo**), ~~no~~.")).toBe("(*ojo*), ~no~.");
  });

  it("keeps the space before inline monospace", () => {
    const text = "Run ```npm install``` then ```npm test``` please";
    expect(toWhatsAppText(text)).toBe(text);
  });

  it("is idempotent", () => {
    const sample =
      "# Hola\n**negrita** ~~x~~ [l](https://b.io)\n| A | B |\n|---|---|\n| 1 | 2 |\n\n\n\n`**c**`";
    const once = toWhatsAppText(sample);
    expect(toWhatsAppText(once)).toBe(once);
  });
});
