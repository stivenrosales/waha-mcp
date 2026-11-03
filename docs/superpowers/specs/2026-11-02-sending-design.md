# waha-mcp: sending messages and attachments — design

Date: 2026-11-02. Supersedes the "no sending" non-goal and anti-goal of
`2026-10-30-waha-mcp-design.md` (§3). Target release: 0.3.0.

## 1. Intent

The owner already uses waha-mcp to analyze WhatsApp with Claude. Today Claude drafts a reply
and the owner copies it into WhatsApp by hand. The owner wants to say "send it" and have the
MCP deliver the message, with attachments, to a direct chat or a group, from the owner's own
number. Personal use only: one owner, their own clients (Claude first; ChatGPT and Gemini CLI
must keep working).

The message must arrive **correctly formatted for WhatsApp**. Claude writes chat Markdown
(`**bold**`, `# headings`, `[text](url)`, tables) which WhatsApp shows as literal garbage.
Correct WhatsApp formatting is a first-class requirement, not polish.

## 2. Goals

- Send text to a direct chat or group, optionally as a reply quoting a message and with
  @mentions in groups.
- Send files the owner gives Claude in the conversation (images, documents, voice notes,
  video) without the file bytes passing through the model.
- Forward an attachment that already exists in WhatsApp (a `media_id` from the read tools).
- Send a location and a contact card.
- Text and captions arrive in valid WhatsApp formatting even when the model writes Markdown.

## 3. Non-goals

- Editing, deleting, reacting, starring, archiving, marking as read, group administration,
  status/stories, polls, buttons, newsletters/channels.
- Scheduling or bulk/broadcast sending.
- Engines other than GOWS (same rule as the read tools).

## 4. Anti-goals (a failure even if it works)

- A message sent that the owner did not explicitly ask to send.
- File bytes routed through model tokens (base64 in tool arguments) as the normal path.
- Markdown leaking into WhatsApp (`**`, `#`, `[x](y)`, `|` tables).
- An upload link that works more than once, never expires, or leaks the WAHA API key.

## 5. Decisions taken with the owner

- **No feature flag / env toggle.** Sending is part of the product from 0.3.0 on. The
  README, badges, server instructions and gateway docs stop describing the server as
  read-only.
- **Attachments via signed upload links** (approach "2" below).
- **Tool shape: hybrid** (approach "3" below).

## 6. Approaches considered

### 6.1 Getting a file from the conversation to the server

1. _Base64 in the tool call._ Rejected: bytes become model output tokens (1 MB ≈ 1.3 M
   chars), slow, expensive, truncates. The model often does not even have the raw bytes.
2. _Signed one-time upload link_ — **chosen.** A tool returns a short-lived URL; the file is
   PUT/POSTed to it outside the model; the send tool references it by `upload_id`. Two ways
   to fill it: Claude's code sandbox runs `curl` (needs network egress to the server's domain
   enabled in the client), or the owner opens the link in a browser and drops the file.
3. _Public URLs only._ Does not cover files given to Claude in the chat.

### 6.2 Tool shape

1. _One `send_message` tool with a `kind` union._ Rejected: large conditional schema, more
   model errors.
2. _One tool per WAHA endpoint._ Rejected: the model must pick image vs document vs voice.
3. _Hybrid_ — **chosen.** `send_text`, `send_media`, `send_location`, `send_contact`,
   `create_upload_link`. `send_media` picks the WAHA endpoint from the mimetype, with an
   optional override.

## 7. Design

### 7.1 Tools

All send tools take `chat_id` (`…@c.us`, `…@lid` or `…@g.us`, as returned by `list_chats`,
`list_groups` or `get_contact`) and return the sent message id and timestamp.

| Tool                 | Inputs                                                                                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send_text`          | `chat_id`, `text`, `reply_to?` (message id), `mentions?` (contact ids)                                                                                                  | Text is normalized to WhatsApp format (7.3). Mentions: each id must appear as `@<number>` in the text; the tool fails with a clear message otherwise. Link previews left to WAHA defaults.                                                                                                                                              |
| `create_upload_link` | `filename`, `mimetype?`                                                                                                                                                 | Returns `upload_id`, `upload_url`, `expires_at`, and a ready `curl` command.                                                                                                                                                                                                                                                            |
| `send_media`         | `chat_id`, exactly one of `upload_id` / `media_id` / `url`; `caption?`, `as?` (`auto`\|`image`\|`video`\|`voice`\|`document`, default `auto`), `filename?`, `reply_to?` | `auto`: `image/*` (not svg/gif-as-doc edge cases, builder's call) → image; `video/*` → video; `audio/*` → voice note (WAHA `convert: true`); anything else → document. `as: "document"` sends a photo without recompression. Caption is normalized like text. Voice notes carry no caption: passing one is an error, not a silent drop. |
| `send_location`      | `chat_id`, `latitude`, `longitude`, `title?`                                                                                                                            |                                                                                                                                                                                                                                                                                                                                         |
| `send_contact`       | `chat_id`, `full_name`, `phone_number`, `organization?`                                                                                                                 | One contact per call.                                                                                                                                                                                                                                                                                                                   |

Annotations for every send tool and `create_upload_link`: `readOnlyHint: false`,
`destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`, so clients ask the
owner to approve each call. `toMcpTool` gains a way to set annotations per tool; read tools
keep `readOnlyHint: true`.

### 7.2 Upload flow

1. `create_upload_link { filename, mimetype? }` creates an upload slot and returns a URL
   `PUBLIC_BASE_URL/upload/<token>`. The token is signed with the existing HMAC secret
   (`signedLink.ts` pattern, separate purpose prefix so media and upload tokens are not
   interchangeable). TTL 15 minutes.
2. The URL accepts:
   - `PUT` with the raw file as body (what `curl -T file URL` does);
   - `POST` `multipart/form-data` with a `file` field;
   - `GET` returns a minimal HTML page with a file picker / drop zone that POSTs to itself,
     for the manual path. Same security headers as the login page.
3. One use: a successful upload consumes the slot; a second upload gets 409. Size above
   `UPLOAD_MAX_BYTES` (default 64 MB) is refused with 413 while streaming, never buffered
   unbounded.
4. The file is stored in `DATA_DIR/uploads/<upload_id>` (mode 0600) with its metadata
   (filename, mimetype — sniffed from the request's Content-Type or the tool's `mimetype`,
   size). `send_media` with an `upload_id` that is not uploaded yet fails with "file not
   uploaded yet; upload it to <url> first".
5. After a successful send the file is deleted. Unused or failed uploads are deleted at
   expiry by a periodic sweep and at startup.
6. The server sends the file to WAHA as `file.data` (base64) with `mimetype` and
   `filename`: server-to-server, no model tokens, and WAHA does not need to reach the public
   URL. `media_id` (forward) uses the existing `openMediaById` and the same path. `url` is
   passed through to WAHA as `file.url`.

### 7.3 WhatsApp formatting

Two layers:

1. **Descriptions.** `send_text` and `send_media` (caption) descriptions, and the server
   instructions, state the WhatsApp syntax exactly:
   - `*bold*`, `_italic_`, `~strikethrough~`, ` ```monospace``` `, `` `inline code` ``
   - `> ` quote, `- ` or `* ` bulleted list, `1. ` numbered list (each at line start)
   - markers must touch the text (`*bold*`, not `* bold *`); they can be combined
     (`*_bold italic_*`)
   - no headings, no tables, no `[text](url)` links (paste the bare URL), no HTML
   - write the message as the owner would send it: no preamble, no "here is your message"
2. **Normalizer** (`application/whatsappFormat.ts`, pure, unit-tested), applied to `text`
   and `caption` before sending:
   - `**x**` / `__x__` → `*x*`; `~~x~~` → `~x~`; single-`*x*` Markdown italic is ambiguous
     with WhatsApp bold and is **left as is** (it is valid WhatsApp bold);
   - `# Heading` (any level) → `*Heading*`;
   - `[text](url)` → `text: url` (or just `url` when text equals url);
   - Markdown tables → one line per row, cells joined with `·`, header row bolded;
   - horizontal rules (`---`, `***`) removed;
   - content inside code fences and inline code is never touched;
   - trailing whitespace trimmed, 3+ blank lines collapsed to 2.

   The tool result echoes the final text actually sent, so the owner can see any rewrite.

### 7.4 Safety

- Server instructions: never call a send tool unless the owner explicitly asked to send in
  this conversation; show the final text and recipient first; one send per request unless
  the owner asked for more.
- Annotations (7.1) make clients request approval per call.
- Upload tokens: signed, scoped to one upload id, 15-minute TTL, single use, size-capped;
  the upload route is the only unauthenticated write route and never touches WAHA.
- WAHA POSTs keep the gateway guarantees: `redirect: "error"`, fixed error messages, no API
  key or base URL in errors, timeout.

### 7.5 Architecture changes

- New port `WhatsAppSender` (domain) next to `WahaGateway`, implemented by the HTTP
  gateway with POST requests (`sendText`, `sendImage`, `sendFile`, `sendVoice`, `sendVideo`,
  `sendLocation`, `sendContactVcard`). Keeping it separate keeps the read port honest and
  lets read-only tests stay untouched.
- New port `UploadStore` (save stream, get, consume, sweep) with a filesystem
  implementation under `DATA_DIR/uploads`.
- `createApp` gains `/upload/:token` (GET/PUT/POST).
- Config: `UPLOAD_MAX_BYTES` (default 64 MB), `UPLOAD_TTL_SECONDS` (default 900).
- The in-memory fake gateway gains a recording sender for tests.

### 7.6 Docs and release

README (tagline, badges, "How it works" diagram, tools table, security notes, examples like
"Send Ana the PDF I just gave you"), CHANGELOG 0.3.0, `.env.example`, `package.json`
description, server instructions.

## 8. Testing

- Unit: formatter (every rule in 7.3, code untouched, idempotent on valid WhatsApp text);
  mimetype → endpoint mapping; mention validation; upload token sign/verify/expiry/purpose.
- Upload route: PUT, multipart POST, HTML GET, 413 while streaming, 409 on reuse, 404 on bad
  token, expiry sweep.
- Tools via the e2e MCP client against the fake sender: correct WAHA payload per tool,
  annotations per tool, errors for missing upload, caption on voice.
- Manual check against a live WAHA (GOWS) before release: each send type once to the
  owner's own chat.

## 9. Calls made by the designer (owner to confirm)

- **WAHA tier.** Media sending needs WAHA Plus features, which ship in the free Core image
  since WAHA 2026.6.1 (release notes: "WAHA Plus features are now part of the WAHA Core
  image"). The owner's WAHA has them. On an older Core, WAHA rejects media sends; the tool
  maps that to a clear "this WAHA does not support sending media; update to 2026.6.1+" error
  instead of a generic failure. README states the minimum version.

- **Failed or uncertain sends.** No automatic retries. The upload slot is consumed only after
  WAHA confirms the send; on a definite failure the `upload_id` stays usable until expiry.
  On a timeout (outcome unknown) the tool says so explicitly and tells the model to check
  the chat with `get_messages` before retrying, so a retry never duplicates silently.
- **Mentions with `@lid` ids.** The text must contain `@<digits>` where `<digits>` is the
  user part of the id passed in `mentions` (phone or lid); the tool validates that. Verify
  against live WAHA how a lid mention renders; if WhatsApp shows a bare number, resolve the
  lid to a phone with the existing `lookupLid` before sending.
- **Other clients.** Send tools are exposed to every client, no per-client filtering. If a
  client (e.g. ChatGPT) restricts write tools, that is the client's policy; reading must
  still work there, checked manually before release.
- **Mimetype precedence.** The tool's `mimetype` argument wins over the upload's
  Content-Type, which wins over the filename extension.
- **Size caps.** `media_id` forwards use `MEDIA_MAX_BYTES`; uploads use `UPLOAD_MAX_BYTES`.

## 10. Left to the builder

- Exact WAHA payload field names per endpoint (`reply_to`, `mentions`, `file`, `convert`),
  verified against the live WAHA version; adjust if GOWS differs.
- GIF and SVG handling in `as: auto`.
- Sweep interval.
- HTML upload page styling (reuse login page look).
