/** Owner-facing notes about scheduled messages (Spanish, like every page the owner sees). */
export const scheduleTexts = {
  sent: (contact: string, text: string) => `📤 Enviado a ${contact}: «${text}»`,
  skipped: (contact: string, reason: string) => `⏭️ No envié a ${contact}: ${reason}`,
  failed: (contact: string) => `⚠️ No se pudo enviar el programado a ${contact}`,
  unknown: (contact: string) =>
    `❔ No sé si salió el programado a ${contact}: revisa el chat antes de reenviarlo`,
  missed: (contact: string, n: number) =>
    `⏱️ ${n} envío(s) programado(s) a ${contact} no salieron a tiempo`,
  ended: (contact: string) => `🏁 Terminó el programado a ${contact}`,
  restoredMissed: (n: number) =>
    `⏱️ ${n} envío(s) programado(s) no salieron mientras tu cuenta estuvo desactivada`,
};

/** Reasons a run is skipped without asking the model. */
export const SKIP_REASONS = {
  mission: "hay una misión activa en este chat",
  budget: "presupuesto mensual agotado",
  llm: "el modelo no respondió",
};
