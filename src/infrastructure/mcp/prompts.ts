import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * Canned workflows. Prompt arguments always arrive as strings, so every field is a
 * string validated with zod. Each prompt names the exact tools to call, in order.
 */

const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const isRealDate = (s: string): boolean => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};

const dateArg = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${what} must be YYYY-MM-DD`)
    .refine(isRealDate, `${what} is not a real calendar date`);

const timezoneArg = z.string().refine(isValidTimezone, "timezone must be an IANA name");

/** Today's date (YYYY-MM-DD) in the given IANA time zone. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const user = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

export function registerPrompts(server: McpServer, opts: { timezone: string }): void {
  server.registerPrompt(
    "daily-review",
    {
      title: "Daily review of pending chats",
      description:
        "Reviews one day of WhatsApp activity and lists what is still pending, then other notable items.",
      argsSchema: z.object({
        date: dateArg("date").optional().describe("Day to review, YYYY-MM-DD. Defaults to today."),
        timezone: timezoneArg
          .optional()
          .describe("IANA time zone for the day. Defaults to the server TIMEZONE."),
      }),
    },
    async (args) => {
      const timezone = args.timezone ?? opts.timezone;
      const date = args.date ?? todayIn(timezone);
      return user(
        [
          `Review my WhatsApp chats for ${date} (time zone ${timezone}) and tell me what is pending.`,
          `1. Call \`get_activity_digest\` with date "${date}" and timezone "${timezone}" (default scope: direct chats; use scope "all" only if I ask to include groups).`,
          `2. Call \`list_pending_replies\` with since set to the start of ${date} in ${timezone} (an ISO date-time with that zone's offset; a bare YYYY-MM-DD would be read as UTC midnight) to see who is waiting for my answer.`,
          `   Note: \`since\` means chats active since then, so pending reflects the current state of those chats. If a pending item's waiting messages are after ${date}, say so instead of presenting it as that day's.`,
          "3. If a chat's context is missing or unclear, fetch it with `get_thread` (around a message id) or `get_messages` BEFORE concluding anything; do not guess.",
          "4. Present the result in this order:",
          "   - Pending first: for each item say who, since when, and what they asked.",
          "   - Then other notable items (decisions, shared files, news worth knowing).",
          "   - Then a short summary of the day.",
          "5. Read every `coverage` block: if chats were skipped, truncated or failed, say so instead of presenting the review as complete.",
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "pending-to-todoist",
    {
      title: "Pending replies to to-do tasks",
      description:
        "Turns pending WhatsApp replies into proposed tasks and creates them only after you confirm.",
      argsSchema: z.object({
        since: dateArg("since")
          .optional()
          .describe("Only consider chats active since this date (YYYY-MM-DD)."),
      }),
    },
    async (args) =>
      user(
        [
          "Turn my pending WhatsApp replies into tasks.",
          `1. Call \`list_pending_replies\`${args.since ? ` with since "${args.since}"` : ""} (default scope: direct chats).`,
          "2. Keep only the real pending items; skip chats that look like noise, broadcasts or already-resolved threads. Use `get_thread` if you need context to decide.",
          "3. For each real pending item propose a task with: title, due date, context (what they asked, in one line) and chat (name and id).",
          "4. Show the proposed tasks and ASK me to confirm (or edit) them. Do not create anything before I answer.",
          "5. Only after I confirm, create the tasks with the Todoist tools available in this client. If no task tool is available, give me the list to copy instead. This WhatsApp server is read-only and cannot create tasks itself.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "group-summary",
    {
      title: "Group summary",
      description:
        "Summarises a WhatsApp group: topics, decisions, open questions and most active participants.",
      argsSchema: z.object({
        group_id: z
          .string()
          .regex(/^[\w.-]+@g\.us$/, "group_id must be a group id ending in @g.us (see list_groups)")
          .describe("Group id (…@g.us) from list_groups."),
        from: dateArg("from").optional().describe("Start date, YYYY-MM-DD."),
        to: dateArg("to").optional().describe("End date, YYYY-MM-DD."),
      }),
    },
    async (args) => {
      const range = [args.from ? `from "${args.from}"` : "", args.to ? `to "${args.to}"` : ""]
        .filter(Boolean)
        .join(" ");
      const withRange = range ? ` with ${range}` : "";
      return user(
        [
          `Summarise the WhatsApp group ${args.group_id}${args.from || args.to ? ` (${[args.from, args.to].filter(Boolean).join(" to ")})` : ""}.`,
          `1. Call \`get_group_info\` with group_id "${args.group_id}" for its name, description and members.`,
          `2. Call \`get_chat_stats\` with chat_id "${args.group_id}"${withRange} for exact activity numbers and the most active participants; do not recount them yourself.`,
          `3. Call \`get_messages\` with chat_id "${args.group_id}"${withRange}, following \`nextCursor\` to page as needed, to read the conversation.`,
          "4. Present: main topics, decisions taken, open questions, and the most active participants (with their numbers from the stats).",
          "5. Respect the coverage notes from `get_chat_stats` and `get_messages`: if history is partial, truncated or unavailable, say so and do not present the summary as complete.",
        ].join("\n"),
      );
    },
  );
}
