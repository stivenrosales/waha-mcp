import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SelfService } from "../../../application/selfService.js";
import { InvalidInputError } from "../../../domain/errors.js";
import type { ToolDefinition, ToolRunContext } from "../defineTool.js";

/** Local, irreversible writes on the caller's own account (no WhatsApp message is sent). */
const SELF_DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const confirmField = z
  .literal(true)
  .describe("Must be true: the owner explicitly asked for this in this conversation.");

const requireSelf = (ctx: ToolRunContext): SelfService => {
  if (!ctx.self) throw new InvalidInputError("Self-service is not available on this server.");
  return ctx.self;
};

const deleteInput = z.object({ confirm: confirmField });
const deleteOutput = z.object({
  messages: z.number(),
  transcripts: z.number(),
  missions: z.number(),
  schedules: z.number(),
});

export const deleteMyDataTool: ToolDefinition<typeof deleteInput, typeof deleteOutput> = {
  name: "delete_my_data",
  title: "Delete my stored data",
  description:
    "Deletes everything this server stores about the owner's conversations, for this account only: cached messages with their edits, reactions and poll votes, voice-note transcripts, and the content of ended missions and ended scheduled messages (plus the run history of active ones). Active missions and scheduled messages keep running; the account, login and WhatsApp link stay. Nothing is deleted from WhatsApp itself. This cannot be undone. Call it only when the owner explicitly asked in this conversation, with confirm: true.",
  inputSchema: deleteInput,
  outputSchema: deleteOutput,
  annotations: SELF_DESTRUCTIVE_ANNOTATIONS,
  async run(_input, ctx) {
    const r = await requireSelf(ctx).deleteMyData();
    return {
      text: `Deleted this account's stored data: ${r.messages} cached messages, ${r.transcripts} transcripts, ${r.missions} ended missions and ${r.schedules} ended scheduled messages (with their edits, reactions, poll votes and run history). Active missions and scheduled messages keep running. Messages are read from WhatsApp again when asked for.`,
      data: r,
    };
  },
};

const unlinkInput = z.object({ confirm: confirmField });
const unlinkOutput = z.object({
  whatsapp: z.enum(["logged_out", "failed"]),
  signedOut: z.literal(true),
});

export const unlinkAccountTool: ToolDefinition<typeof unlinkInput, typeof unlinkOutput> = {
  name: "unlink_account",
  title: "Unlink my WhatsApp and sign out",
  description:
    "Revokes this server's access to the owner's account: logs the owner's WhatsApp out of this server (it disappears from Linked devices) and signs out every connected app, this one included, so later calls fail until the owner signs in again. Stored data is kept (use delete_my_data for that); the owner can link WhatsApp again at /pair. Call it only when the owner explicitly asked in this conversation, with confirm: true.",
  inputSchema: unlinkInput,
  outputSchema: unlinkOutput,
  annotations: SELF_DESTRUCTIVE_ANNOTATIONS,
  async run(_input, ctx) {
    const r = await requireSelf(ctx).unlink();
    const pair = `${ctx.config.publicBaseUrl.replace(/\/+$/, "")}/pair`;
    const done =
      r.whatsapp === "logged_out"
        ? "WhatsApp is unlinked from this server and every connected app is signed out, this one included."
        : "Every connected app is signed out, this one included. WhatsApp could not be logged out right now: remove this server under Linked devices on your phone.";
    return {
      text: `${done} To use it again, sign in at ${pair} and scan the QR code.`,
      data: r,
    };
  },
};
