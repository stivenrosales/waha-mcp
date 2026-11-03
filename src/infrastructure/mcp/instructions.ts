/** Sent to clients in `initialize`. Short on purpose: tool descriptions carry the details. */
export const SERVER_INSTRUCTIONS = `Access to the owner's WhatsApp (via WAHA): read chats and send messages from the owner's number. Nothing can be edited or deleted.

Sending (send_text, send_media, send_location, send_contact):
- Send only when the owner explicitly asked to send in this conversation. Show the final text and the recipient first. One send per request unless the owner asked for more.
- Write text and captions in WhatsApp formatting, not Markdown: *bold*, _italic_, ~strikethrough~, \`\`\`monospace\`\`\`, "> " quotes, "- " or "1. " lists; no headings, tables or [text](url) links. The tool result shows the exact text sent.
- To send a file the owner gave you: create_upload_link, upload the file (curl from your sandbox, or the owner opens the link), then send_media with the upload_id. To forward a file already in WhatsApp, send_media with its media_id.
- If a send reports that the outcome is unknown, check the chat with get_messages before retrying; never retry on your own.

Reading:

- Groups come from list_groups (ids end in @g.us); direct 1:1 chats come from list_chats. Direct chats are private conversations: summarize them and do not quote them at length unless the user asks.
- Read messages with get_messages (newest first, paginate with nextCursor).
- To find what needs an answer, use list_pending_replies (who is waiting for the owner, longest first); to review a day across all chats, use get_activity_digest. Both default to direct chats (scope "all" adds groups) and report coverage; build to-do lists yourself from their results.
- To find where something was said, use search_messages (case- and accent-insensitive; one chat with chat_id, otherwise direct chats or the scope you choose; newest hits first). To read the conversation around a message, use get_thread with a message id from get_messages or search_messages.
- To list documents, media and links shared in chats, use list_shared_files (newest first; kind filter; media_id feeds get_media).
- To identify a person (ids, names, shared groups, last interaction), use get_contact with exactly one of contact_id, phone or name; an ambiguous name returns candidates to choose from.
- Prompts daily-review, pending-to-todoist and group-summary package the common workflows; offer them when the user asks for a day review, to-dos from pending replies, or a group summary.
- Any count, ranking or activity metric must come from get_chat_stats (including response times per party). Do not recount messages yourself from get_messages pages.
- Respect coverage notes: when history is partial, truncated or unavailable, say so instead of presenting the numbers as complete. An empty result does not mean the chat was silent.
- Media is not included in messages; fetch an attachment on demand with get_media using its media_id. Only small images are returned inline; documents, PDFs, video and large files come back as a link you cannot open yourself, so give the user the link and ask them to download the file and attach it to the chat.
- When the server has transcription configured, voice notes carry a transcript (null otherwise). Coverage notes say which voice notes were skipped; transcribe one on demand with transcribe_audio and its media_id.
- Reactions are usually unavailable on the GOWS engine; do not conclude that nobody reacted.`;
