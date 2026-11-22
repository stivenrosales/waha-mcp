import { ownerStyleHint } from "../../application/ownerStyle.js";
import type { ContextLine } from "../../application/schedules/compose.js";
import type { ScheduleTenantPort } from "../../application/schedules/runner.js";
import { WahaNotFoundError } from "../../domain/errors.js";
import { formatLocal } from "../../domain/schedules/recurrence.js";
import type { TenantRuntime, TenantToolContext } from "../tenants/runtime.js";

/** How much of the chat an AI-composed run reads: the last messages, within these days. */
export const CONTEXT_MESSAGES = 40;
export const CONTEXT_DAYS = 14;
/** How much of the chat the owner's style is derived from (only the owner's lines count). */
export const STYLE_MESSAGES = 100;
export const STYLE_DAYS = 90;

/**
 * The chat's recent text messages (and stored voice-note transcripts), oldest first, with local
 * times. Messages with no text are skipped. A chat WAHA has never seen has no context.
 */
export async function readScheduleContext(
  ctx: Pick<TenantToolContext, "gateway" | "mapper" | "transcription">,
  chatId: string,
  timezone: string,
  now: Date,
  window: { messages: number; days: number } = { messages: CONTEXT_MESSAGES, days: CONTEXT_DAYS },
): Promise<ContextLine[]> {
  const mapper = await ctx.mapper();
  const from = Math.floor((now.getTime() - window.days * 24 * 3600_000) / 1000);
  let raws: unknown[];
  try {
    raws = await ctx.gateway.getMessages(chatId, { limit: window.messages, offset: 0, from });
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

/** How many messages after a follow-up's anchor are read to find the contact's reply. */
export const REPLY_CHECK_MESSAGES = 100;

/**
 * True when the contact wrote in the chat after `sinceIso`: any message not from the owner,
 * text or media, except reactions and system messages. A chat WAHA has never seen has no reply;
 * any other read failure is thrown (the runner then skips the follow-up).
 */
export async function contactRepliedSince(
  ctx: Pick<TenantToolContext, "gateway" | "mapper">,
  chatId: string,
  sinceIso: string,
): Promise<boolean> {
  const mapper = await ctx.mapper();
  const since = Date.parse(sinceIso);
  let raws: unknown[];
  try {
    raws = await ctx.gateway.getMessages(chatId, {
      limit: REPLY_CHECK_MESSAGES,
      offset: 0,
      from: Math.floor(since / 1000),
    });
  } catch (error) {
    if (error instanceof WahaNotFoundError) return false;
    throw error;
  }
  return raws
    .filter((raw) => !mapper.reaction(raw))
    .map((raw) => mapper.message(raw))
    .some((m) => !m.fromMe && m.type !== "system" && Date.parse(m.timestamp) > since);
}

/**
 * The owner's writing style in this chat (`ownerStyleHint`), from the owner's own text messages
 * among the chat's last `STYLE_MESSAGES` within `STYLE_DAYS`; null when there are too few.
 */
export async function readOwnerStyle(
  ctx: Pick<TenantToolContext, "gateway" | "mapper" | "transcription">,
  chatId: string,
  now: Date,
): Promise<string | null> {
  const lines = await readScheduleContext(ctx, chatId, "UTC", now, {
    messages: STYLE_MESSAGES,
    days: STYLE_DAYS,
  });
  return ownerStyleHint(lines.filter((l) => l.fromOwner).map((l) => l.text));
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
    repliedSince: (chatId, sinceIso) => contactRepliedSince(ctx, chatId, sinceIso),
  };
}
