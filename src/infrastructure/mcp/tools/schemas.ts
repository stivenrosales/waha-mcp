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
