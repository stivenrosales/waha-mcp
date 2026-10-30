/** Sent to clients in `initialize`. Short on purpose: tool descriptions carry the details. */
export const SERVER_INSTRUCTIONS = `Read-only access to the owner's WhatsApp (via WAHA). Nothing can be sent, edited or deleted.

- Groups come from list_groups (ids end in @g.us); direct 1:1 chats come from list_chats. Direct chats are private conversations: summarize them and do not quote them at length unless the user asks.
- Read messages with get_messages (newest first, paginate with nextCursor).
- To find what needs an answer, use list_pending_replies (who is waiting for the owner, longest first); to review a day across all chats, use get_activity_digest. Both default to direct chats (scope "all" adds groups) and report coverage; build to-do lists yourself from their results.
- Any count, ranking or activity metric must come from get_chat_stats. Do not recount messages yourself from get_messages pages.
- Respect coverage notes: when history is partial, truncated or unavailable, say so instead of presenting the numbers as complete. An empty result does not mean the chat was silent.
- Media is not included in messages; fetch an attachment on demand with get_media using its media_id.
- Reactions are usually unavailable on the GOWS engine; do not conclude that nobody reacted.`;
