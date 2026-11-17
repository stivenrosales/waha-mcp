import type { StopReason } from "../../domain/missions/mission.js";
import type { WhatsAppSender } from "../../domain/ports/WhatsAppSender.js";

/** Owner-facing texts (Spanish, like every page the owner sees). */
const STOP_REASONS: Record<StopReason, string> = {
  refusal: "el modelo se negó a continuar",
  restriction: "restricción de WhatsApp",
  revoked: "cuenta revocada",
  errors: "errores del modelo",
  budget: "presupuesto mensual agotado",
  llm_cap: "límite de llamadas al modelo",
  message_cap: "límite de mensajes",
};

export const ownerTexts = {
  succeeded: (contact: string, summary: string) => `✅ Misión con ${contact} cumplida: ${summary}`,
  failed: (contact: string, summary: string) => `⚠️ Misión con ${contact} fallida: ${summary}`,
  expired: (contact: string) => `⏱️ Misión con ${contact} vencida`,
  stopped: (contact: string, reason: StopReason) =>
    `⛔ Misión con ${contact} detenida (${STOP_REASONS[reason]})`,
  question: (contact: string, question: string) => `❓ ${contact} pregunta: ${question}`,
  paused: () =>
    "⏸️ Misiones en pausa: WhatsApp limitó temporalmente los mensajes de tu cuenta. Siguen cuando se levante el límite.",
};

/** The owner's own chat: `waId` is stored as the phone JID; a bare number gets `@c.us`. */
export function ownerChatId(waId: string | null): string | null {
  if (!waId) return null;
  return waId.includes("@") ? waId : `${waId}@c.us`;
}

/** How notifications name the contact: the mission's label, else the chat's number. */
export function contactLabel(contactName: string | null, chatId: string): string {
  if (contactName && contactName.trim() !== "") return contactName.trim();
  const user = chatId.split("@")[0] ?? chatId;
  return chatId.endsWith("@c.us") ? `+${user}` : user;
}

/**
 * A plain `sendText` to the owner's own chat (no pacing: it is not a conversation). Best
 * effort: a failure is logged by mission id only and never stops the engine.
 */
export async function notifyOwner(
  deps: { sender: WhatsAppSender; logger: { info(message: string): void } },
  q: { ownerChatId: string | null; missionId: string; text: string },
): Promise<void> {
  if (!q.ownerChatId) {
    deps.logger.info(`mission=${q.missionId} notify=skipped reason=no-owner-chat`);
    return;
  }
  try {
    await deps.sender.sendText({ chatId: q.ownerChatId, text: q.text });
  } catch {
    deps.logger.info(`mission=${q.missionId} notify=failed`);
  }
}
