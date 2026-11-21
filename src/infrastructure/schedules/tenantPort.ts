import type { ContextLine } from "../../application/schedules/compose.js";
import type { ScheduleTenantPort } from "../../application/schedules/runner.js";
import { WahaNotFoundError } from "../../domain/errors.js";
import { formatLocal } from "../../domain/schedules/recurrence.js";
import type { TenantRuntime, TenantToolContext } from "../tenants/runtime.js";

/** How much of the chat an AI-composed run reads: the last messages, within these days. */
export const CONTEXT_MESSAGES = 40;
export const CONTEXT_DAYS = 14;

/**
 * The chat's recent text messages (and stored voice-note transcripts), oldest first, with local
 * times. Messages with no text are skipped. A chat WAHA has never seen has no context.
 */
export async function readScheduleContext(
  ctx: Pick<TenantToolContext, "gateway" | "mapper" | "transcription">,
  chatId: string,
  timezone: string,
  now: Date,
): Promise<ContextLine[]> {
  const mapper = await ctx.mapper();
  const from = Math.floor((now.getTime() - CONTEXT_DAYS * 24 * 3600_000) / 1000);
  let raws: unknown[];
  try {
    raws = await ctx.gateway.getMessages(chatId, { limit: CONTEXT_MESSAGES, offset: 0, from });
  } catch (error) {
    if (error instanceof WahaNotFoundError) return [];
    throw error;
  }
  const messages = raws.filter((raw) => !mapper.reaction(raw)).map((raw) => mapper.message(raw));
  await ctx.transcription.attachStored(messages);
  return messages
    .map((m) => ({ m, text: (m.text ?? m.transcript ?? "").trim() }))
    .filter((x) => x.text !== "")
    .sort((a, b) => a.m.timestamp.localeCompare(b.m.timestamp))
    .map(({ m, text }) => ({
      at: formatLocal(new Date(m.timestamp), timezone),
      fromOwner: m.fromMe,
      text,
    }));
}

/** The schedule runner's view of one tenant runtime. */
export function scheduleTenantPort(
  runtime: TenantRuntime,
  timezone: string,
  now: () => Date,
): ScheduleTenantPort {
  const ctx = runtime.context;
  return {
    sender: ctx.sender,
    log: runtime.scheduleLog,
    lookupLid: (lid) => ctx.gateway.lookupLid(lid),
    readContext: (chatId) => readScheduleContext(ctx, chatId, timezone, now()),
  };
}
