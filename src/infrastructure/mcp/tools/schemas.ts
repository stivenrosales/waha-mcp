import { z } from "zod";

/** Output schemas mirroring the domain types; advertised to clients as JSON Schema. */

const isoOrNull = z.string().nullable();

export const groupSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  participantCount: z.number(),
  lastActivity: isoOrNull,
});

export const groupInfoSchema = groupSummarySchema.extend({
  description: z.string().nullable(),
  createdAt: isoOrNull,
  participants: z.array(
    z.object({ id: z.string(), phone: z.string().nullable(), isAdmin: z.boolean() }),
  ),
});

export const chatSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  lastActivity: isoOrNull,
});

const messageTypeSchema = z.enum([
  "text",
  "image",
  "video",
  "audio",
  "voice",
  "document",
  "sticker",
  "location",
  "contact",
  "poll",
  "system",
  "deleted",
  "unknown",
]);

export const messageSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  author: z.object({ id: z.string(), phone: z.string().nullable(), name: z.string().nullable() }),
  fromMe: z.boolean(),
  type: messageTypeSchema,
  rawType: z.string().optional(),
  text: z.string().nullable(),
  replyToId: z.string().nullable(),
  mentions: z.array(z.string()),
  reactions: z.array(z.object({ emoji: z.string(), by: z.string() })),
  attachment: z
    .object({
      kind: z.enum(["image", "video", "audio", "voice", "document", "sticker"]),
      mimetype: z.string().nullable(),
      size: z.number().nullable(),
      filename: z.string().nullable(),
      caption: z.string().nullable(),
      mediaId: z.string().nullable(),
      available: z.boolean(),
    })
    .nullable(),
  location: z.object({ lat: z.number(), lng: z.number(), name: z.string().nullable() }).nullable(),
  contact: z.object({ name: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  poll: z.object({ question: z.string(), options: z.array(z.string()) }).nullable(),
});

export const chatStatsSchema = z.object({
  chatId: z.string(),
  timezone: z.string(),
  totalMessages: z.number(),
  perParticipant: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      messages: z.number(),
      byType: z.record(z.string(), z.number()),
    }),
  ),
  perDay: z.array(z.object({ date: z.string(), messages: z.number() })),
  perHour: z.array(z.object({ hour: z.number(), messages: z.number() })),
  replies: z.array(z.object({ from: z.string(), to: z.string(), count: z.number() })),
  silentMembers: z.array(z.string()),
  coverage: z.object({
    requestedFrom: isoOrNull,
    requestedTo: isoOrNull,
    firstMessageAt: isoOrNull,
    lastMessageAt: isoOrNull,
    truncated: z.boolean(),
    note: z.string(),
  }),
});

export const isoDate = (what: string) =>
  z
    .string()
    .describe(
      `${what} as an ISO 8601 date or date-time (e.g. "2026-10-01" or "2026-10-01T08:00:00-05:00").`,
    );

/** One display line for a person or chat: "Name (id)" or just the id. */
export const label = (name: string | null, id: string): string => (name ? `${name} (${id})` : id);

export const scopeSchema = z
  .enum(["direct", "groups", "all"])
  .default("direct")
  .describe(
    'Which chats to include: "direct" (1:1, default), "groups" or "all". In groups only mentions of the owner and replies to the owner count as pending.',
  );

export const compactMessageSchema = z.object({
  id: z.string(),
  at: z.string(),
  from: z.string(),
  type: messageTypeSchema,
  text: z.string().nullable(),
  hasAttachment: z.boolean(),
});

/** What a multi-chat call did and did not read; the model must never assume completeness. */
export const coverageSchema = z.object({
  chatsScanned: z.number(),
  chatsSkipped: z.number(),
  truncated: z.boolean(),
  failedChats: z.array(z.string()),
  notes: z.array(z.string()),
});

export const pendingRepliesSchema = z.object({
  since: z.string(),
  scope: z.enum(["direct", "groups", "all"]),
  totalPending: z.number(),
  pending: z.array(
    z.object({
      chatId: z.string(),
      name: z.string(),
      isGroup: z.boolean(),
      waitingSince: z.string(),
      waitingMinutes: z.number(),
      unansweredCount: z.number(),
      reason: z.enum(["last-message-from-them", "mentioned", "replied-to-you"]),
      lastMessages: z.array(compactMessageSchema),
    }),
  ),
  coverage: coverageSchema,
});

export const activityDigestSchema = z.object({
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
  scope: z.enum(["direct", "groups", "all"]),
  chats: z.array(
    z.object({
      chatId: z.string(),
      name: z.string(),
      isGroup: z.boolean(),
      messageCount: z.number(),
      lastFrom: z.string(),
      awaitingReply: z.boolean(),
      messages: z.array(compactMessageSchema),
      messagesOmitted: z.number(),
    }),
  ),
  coverage: coverageSchema,
});

export const searchMessagesSchema = z.object({
  query: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  scope: z.enum(["direct", "groups", "all"]).nullable(),
  totalMatches: z.number(),
  hits: z.array(
    z.object({
      chatId: z.string(),
      chatName: z.string(),
      isGroup: z.boolean(),
      message: compactMessageSchema,
      snippet: z.string(),
    }),
  ),
  coverage: coverageSchema,
});

export const threadSchema = z.object({
  chatId: z.string(),
  anchor: messageSchema,
  before: z.array(messageSchema),
  after: z.array(messageSchema),
  replyChain: z.array(messageSchema),
  coverage: z.object({
    messagesRead: z.number(),
    missingAncestors: z.array(z.string()),
    notes: z.array(z.string()),
  }),
});

export const sharedFilesSchema = z.object({
  from: z.string(),
  to: z.string().nullable(),
  scope: z.enum(["direct", "groups", "all"]).nullable(),
  kind: z.enum(["document", "image", "video", "audio", "voice", "sticker", "link"]).nullable(),
  totalMatches: z.number(),
  items: z.array(
    z.object({
      chatId: z.string(),
      chatName: z.string(),
      messageId: z.string(),
      at: z.string(),
      kind: z.enum(["document", "image", "video", "audio", "voice", "sticker", "link"]),
      filename: z.string().nullable(),
      mimetype: z.string().nullable(),
      size: z.number().nullable(),
      url: z.string().nullable(),
      mediaId: z.string().nullable(),
    }),
  ),
  coverage: coverageSchema,
});

export const contactSchema = z.object({
  match: z.enum(["unique", "ambiguous", "none"]),
  contact: z
    .object({
      id: z.string(),
      lid: z.string().nullable(),
      phone: z.string().nullable(),
      name: z.string().nullable(),
      pushname: z.string().nullable(),
      groupsInCommon: z.array(z.object({ id: z.string(), name: z.string() })),
      lastInteraction: z.string().nullable(),
    })
    .nullable(),
  candidates: z.array(
    z.object({
      id: z.string(),
      phone: z.string().nullable(),
      name: z.string().nullable(),
      pushname: z.string().nullable(),
    }),
  ),
  totalCandidates: z.number(),
});

/** Shared closing lines of every multi-chat summary. */
export function coverageText(c: z.infer<typeof coverageSchema>): string {
  const head = `Coverage: ${c.chatsScanned} chats scanned, ${c.chatsSkipped} skipped, ${c.failedChats.length} failed${c.truncated ? " (INCOMPLETE)" : ""}.`;
  return [head, ...c.notes.map((n) => `- ${n}`)].join("\n");
}
