/** Sent to clients in `initialize`. Short on purpose: tool descriptions carry the details. */
export const SERVER_INSTRUCTIONS = `Access to the owner's WhatsApp (via WAHA): read chats, send messages from the owner's number, and edit or delete the owner's own messages.

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
- Reactions come from webhooks; when the server has no WAHA_WEBHOOK_SECRET they may be missing, so do not conclude that nobody reacted.

Message actions:
- React (react_message) only when the owner asked.
- Edit (edit_message) or delete (delete_message, for everyone, cannot be undone) only when the owner explicitly asked in this conversation; first show the message (text and chat) and, for edits, the new text. Only the owner's own messages.

Missions (start_mission, get_mission, list_missions, answer_mission, cancel_mission; only when the server has them configured):
- A mission hands one direct chat to a server-side assistant that converses on the owner's behalf until the objective is met, it fails, the deadline passes, or the owner cancels it. Start one only when the owner asked; show them the system prompt and the recipient first.
- When the assistant needs the owner, they get a WhatsApp message to themselves; relay their reply with answer_mission. Any message the owner sends in that chat (including through send_text or send_media) takes the mission over and the assistant goes silent.
- Results can end with "Missions: <n> finished — call list_missions."; when they do, check list_missions and tell the owner the outcomes.`;

/** Appended to the instructions for the admin only (members never see the admin tools). */
export const ADMIN_INSTRUCTIONS = `Tenant management (admin only; list_tenants, get_transcription_usage, get_tool_usage, get_llm_usage, create_invite, reset_password, revoke_tenant, restore_tenant, delete_tenant):
- Each tenant is one person's WhatsApp account on this server; the tools above act on the admin's own account (the admin tenant), never on another tenant's chats.
- create_invite and reset_password return single-use links (72 hours); give them only to that tenant's owner.
- delete_tenant is permanent (account, key, cached messages and WhatsApp session). Confirm with the admin first; prefer revoke_tenant when access only needs to stop.
- get_transcription_usage reports voice-note transcription spend per tenant (default: the current month). Costs are what the provider reported; spend from before usage tracking was added is not included.
- get_tool_usage reports how each tenant uses this server: tool calls and errors per tool and the last call (default: the current month). Calls from before usage tracking was added are not included.
- get_llm_usage reports mission LLM spend per tenant: calls, missions, tokens and cost (default: the current month). Costs are what the provider reported; calls without a reported cost are counted separately.`;
