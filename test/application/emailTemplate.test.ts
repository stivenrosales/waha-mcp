import { describe, expect, it } from "vitest";
import { brandedEmail } from "../../src/application/emailTemplate.js";

const email = brandedEmail({
  preheader: "Falta un paso",
  title: "Te damos la bienvenida a Zenbox",
  paragraphs: ["Hola <Ana>:", "Crea tu cuenta."],
  button: { label: "Crear mi cuenta", url: "https://app.example.com/invite/a?b=1&c=2" },
  note: "El enlace vale 72 horas.",
  footer: "Si no fuiste tú, ignora este correo.",
});

describe("branded email", () => {
  it("renders the logo, title, button and a copyable link, escaping every value", () => {
    expect(email.html).toContain('<img src="https://usezenbox.com/email-logo.png"');
    expect(email.html).toContain('alt="Zenbox"');
    expect(email.html).toContain("Te damos la bienvenida a Zenbox");
    expect(email.html).toContain("Hola &lt;Ana&gt;:");
    expect(email.html).not.toContain("<Ana>");
    expect(email.html).toContain('href="https://app.example.com/invite/a?b=1&amp;c=2"');
    expect(email.html).toContain(">Crear mi cuenta</a>");
    expect(email.html).toContain("Si el botón no funciona");
    expect(email.html).toContain("Falta un paso");
  });

  it("has a plain-text copy with every part and the raw link", () => {
    expect(email.text).toBe(
      [
        "Te damos la bienvenida a Zenbox",
        "Hola <Ana>:",
        "Crea tu cuenta.",
        "Crear mi cuenta: https://app.example.com/invite/a?b=1&c=2",
        "El enlace vale 72 horas.",
        "Si no fuiste tú, ignora este correo.",
      ].join("\n\n"),
    );
  });
});
