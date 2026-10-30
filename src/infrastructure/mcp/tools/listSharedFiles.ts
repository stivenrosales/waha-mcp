import { z } from "zod";
import { FILE_KINDS, listSharedFiles } from "../../../application/files.js";
import type { ToolDefinition } from "../defineTool.js";
import { coverageText, isoDate, scopeSchema, sharedFilesSchema } from "./schemas.js";

const inputSchema = z.object({
  chat_id: z
    .string()
    .min(1)
    .optional()
    .describe("Read only this chat (group or direct). Without it, `scope` picks the chats."),
  scope: scopeSchema,
  kind: z
    .enum(FILE_KINDS)
    .optional()
    .describe('Only this kind: a media type, or "link" for URLs found in texts and captions.'),
  from: isoDate("Start of the range (default: 30 days ago)").optional(),
  to: isoDate("End of the range").optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum items to return, newest first (default 50)."),
});

const size = (n: number | null) => (n === null ? "" : ` · ${n} bytes`);

export const listSharedFilesTool: ToolDefinition<typeof inputSchema, typeof sharedFilesSchema> = {
  name: "list_shared_files",
  title: "List shared files and links",
  description:
    'Lists documents, images, videos, audio, voice notes, stickers and links shared in chats, newest first, with file name, type, size and the media_id for get_media (links carry their url instead). Give chat_id for one chat of any type; otherwise it scans the chats of `scope` (default "direct") active in the range (default last 30 days). Links are found in message texts and captions with a conservative http(s) pattern. Always read coverage: it states which chats were scanned and what is missing.',
  inputSchema,
  outputSchema: sharedFilesSchema,
  async run(input, { gateway, mapper, config }) {
    const r = await listSharedFiles(
      gateway,
      mapper,
      {
        chatId: input.chat_id,
        scope: input.scope,
        kind: input.kind,
        from: input.from,
        to: input.to,
        limit: input.limit,
      },
      { statsMaxMessages: config.statsMaxMessages },
    );
    const where = r.scope === null ? `chat ${input.chat_id}` : `scope ${r.scope}`;
    const lines = r.items.map((i) =>
      i.kind === "link"
        ? `- [${i.at}] ${i.chatName} (${i.chatId}) · link ${i.url} · message id=${i.messageId}`
        : `- [${i.at}] ${i.chatName} (${i.chatId}) · ${i.kind} ${i.filename ?? "(no name)"}${size(i.size)} · message id=${i.messageId} · media_id=${i.mediaId ?? "n/a"}`,
    );
    const head =
      r.totalMatches === 0
        ? `No shared ${r.kind ?? "files or links"} since ${r.from} (${where}).`
        : `${r.totalMatches} shared ${r.kind ?? "files and links"} since ${r.from} (${where})${r.totalMatches > r.items.length ? `, showing the newest ${r.items.length}` : ""}:`;
    return { text: [head, ...lines, coverageText(r.coverage)].join("\n"), data: r };
  },
};
