# Missions spike findings (Task 1)

Date: 2026-11-17. Throwaway spike for `2026-11-16-missions-design.md` ("Spike before build").
OpenRouter items were run **live** against `anthropic/claude-haiku-5.5` with `@anthropic-ai/sdk` 1.4.0
(`baseURL: "https://openrouter.ai/api"`, `authToken`, `apiKey: null`). WAHA items come from the official
docs (waha.devlike.pro) and the WAHA source at tag `2026.9.2` (github.com/devlikeapro/waha); **no live WAHA
call was made**, so every WAHA item is marked *per docs/source — to confirm live in T4/T11*.

Total OpenRouter spend for the spike: about **US$0.00095** (15 billed requests).

## 1. OpenRouter `/api/v1/messages` with Haiku 5.5

| # | Item | Result | Evidence |
|---|------|--------|----------|
| 1 | `provider` body field accepted on `/api/v1/messages` | **Works** | Request with `provider: {order:["anthropic"], allow_fallbacks:true}` → 200. |
| 2 | Provider ordering honored | **Works** | `order:["amazon-bedrock"], allow_fallbacks:false` → served by Amazon Bedrock (body `provider: "Amazon Bedrock"`, id `msg_bdrk_…`, `/generation` `provider_name: "Amazon Bedrock"`). `order:["nonexistent-provider-xyz"], allow_fallbacks:false` → **404** `not_found_error` "No endpoints found for anthropic/claude-haiku-5.5. Every candidate endpoint was removed during routing…". |
| 3 | Which provider served | **Works, two ways** | (a) Response body has a top-level **`provider`** string (`"Anthropic"`, `"Amazon Bedrock"`) — no extra call needed. (b) Response header **`x-generation-id`** (`gen-…`) → `GET https://openrouter.ai/api/v1/generation?id=<gen id>` returns `provider_name`, `model` (`anthropic/claude-haiku-5.5-20261007`), `total_cost`, `provider_responses[]`. The Anthropic message id (`msg_…`) is **rejected** by `/generation` (400 "Invalid generation ID"). No provider response header exists. With `order:["anthropic"]` the Anthropic endpoint served every call. |
| 4 | `role: "system"` message mid-`messages` | **Works** | Last entry after a user turn: model obeyed ("reply PINEAPPLE" → `PINEAPPLE`). Between a user and an assistant turn: obeyed later (codeword → `MANGO`). |
| 5 | `output_config.effort` | **Works (validated)** | `low` and `high` → 200. `effort: "bogus"` → 400 `invalid_request_error`, metadata lists `"low"\|"medium"\|"high"\|"xhigh"\|"max"` at path `output_config.effort` (so OpenRouter validates and forwards it). |
| 6 | `cache_control` | **Works** | System block (~3.7k tokens) with `cache_control: {type:"ephemeral"}`: turn 1 `cache_creation_input_tokens: 3731`, turn 2 `cache_read_input_tokens: 3731`; cost fell from $0.00047 to $0.000043. |
| 7 | `strict: true` tool + `tool_choice: {type:"auto"}` | **Works (accepted)** | `stop_reason: "tool_use"`, input `{"outcome":"success","summary":"…"}` matched the schema (`additionalProperties:false`, enum). Strict enforcement itself was not stress-tested. |
| 8 | Image block (base64 PNG) | **Works** | 16×16 red PNG → `Red`. |
| 9 | PDF block (base64 `document`) | **Works** | Hand-written one-page PDF "INVOICE 4471" → `INVOICE 4471` (1594 input tokens). |
| 10 | `usage.cost` | **Present, USD** | Every response has `usage.cost` (number, USD), plus `usage.cost_details.{upstream_inference_cost, upstream_inference_prompt_cost, upstream_inference_completions_cost}` and `usage.is_byok`. Check: 18 in × $0.10/M + 4 out × $0.50/M = $0.0000038 = `usage.cost`. Equals `/generation` `total_cost`. |

### Response shape (observed)

Top-level keys: `id, type, role, container, content, model, stop_reason, stop_details, stop_sequence, usage,
context_management, provider`. `model` echoes `anthropic/claude-haiku-5.5`.

```json
"usage": {
  "input_tokens": 18, "output_tokens": 4,
  "output_tokens_details": { "thinking_tokens": 0 },
  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
  "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0 },
  "inference_geo": "global", "server_tool_use": null, "service_tier": "standard", "speed": "standard",
  "cost": 0.0000038, "is_byok": false,
  "cost_details": { "upstream_inference_cost": 0.0000038, "upstream_inference_prompt_cost": 0.0000018,
                    "upstream_inference_completions_cost": 0.000002 }
}
```

Other observations:
- Haiku 5.5 thinks adaptively even at `effort: "low"` when the turn needs it: the mid-conversation system
  turn returned a `thinking` block (180 thinking tokens, counted inside `output_tokens`). The history must keep
  `content` blocks as returned (thinking included) when appending the assistant turn.
- `output_tokens_details.thinking_tokens` exposes the thinking share of output tokens.
- The impossible-order 404 maps to `LlmRejectedError(404)` in the current client (non-retryable) — correct.
- Haiku 5.5 endpoints on OpenRouter today: Anthropic, Amazon Bedrock, Google Vertex, Azure, Claude Platform on
  AWS (+ regional variants with a ~10% surcharge, which default routing filters out). All at the same price.

## 2. WAHA 2026.9.2 (GOWS) webhooks — per docs/source, to confirm live in T4/T11

| # | Item | Result | Evidence |
|---|------|--------|----------|
| 1 | Session config shape | Per docs | `config.webhooks[]` with `url`, `events`, `hmac.key`, `retries.{policy,delaySeconds,attempts}`, `customHeaders[{name,value}]` (docs "Events", "Sessions"). |
| 2 | Registering on an existing session | Per docs — **caveat** | `PUT /api/sessions/{session}` takes the **full** new config; if the session is not `STOPPED` it is **stopped and started** again. So T4 must GET the current config, merge `webhooks`, PUT once, and expect a restart. |
| 3 | Event names | Per docs/source | `message` (GOWS: only messages **not** from me), `message.any` (from me + others), `session.status`, plus `message.reaction`, `message.ack`, `message.edited`, `message.revoked`, … |
| 4 | Signature | Per source | Headers `X-Webhook-Hmac` (hex) and `X-Webhook-Hmac-Algorithm: sha512`; `crypto.createHmac("sha512", hmac.key).update(body).digest("hex")` where `body` is the exact JSON string POSTed. Only sent when `hmac.key` is set. |
| 5 | Other headers | Per source | `X-Webhook-Request-Id` (uniqid), `X-Webhook-Timestamp` (= envelope `timestamp`, ms; **not** part of the HMAC), `User-Agent: WAHA/<version>`, `content-type: application/json`, plus `customHeaders`. |
| 6 | Retries | Per source — **caveat** | Defaults: **15 attempts, 2 s, constant**. `retryCondition: () => true`: any failure, **including 4xx such as 401**, is retried. Delivery is fire-and-forget (`setImmediate` per event), so ordering across events is not guaranteed. |
| 7 | Incoming DM payload | Per source | `message` and `message.any`, `fromMe:false`, `source:"app"`. |
| 8 | `fromMe` typed on the phone | Per source | Only `message.any`; `fromMe:true`, `source:"app"` (sender device id ≠ WAHA's device id). |
| 9 | Sent via `/api/sendText` | Per source/docs | Only `message.any`; `fromMe:true`, `source:"api"` (sender device id = WAHA's device). Whether GOWS echoes our own sends at all must be confirmed live. Note: every send through this WAHA device (missions **and** MCP `send_text`) is `source:"api"`. |
| 10 | `session.status` payload | Per source | `{name, status, statuses:[{status,timestamp}] (last 3), data}`; `status` ∈ `STOPPED, STARTING, SCAN_QR_CODE, PASSKEY_REQUIRED, PASSKEY_CONFIRMATION_REQUIRED, WORKING, FAILED`. WORKING is delayed up to 2 s until `me` is known. |
| 11 | Payload accepted by `EngineMapper.message` | **Yes** (source + synthetic check) | See §2.3. |

### 2.1 Session config (what T4 sends)

```json
{
  "name": "<tenant.wahaSession>",
  "config": {
    "metadata": { "tenant": "<tenantId>" },
    "webhooks": [{
      "url": "{PUBLIC_BASE_URL}/webhooks/waha",
      "events": ["message.any", "session.status"],
      "hmac": { "key": "<WAHA_WEBHOOK_SECRET>" },
      "retries": { "policy": "constant", "delaySeconds": 2, "attempts": 15 },
      "customHeaders": null
    }]
  }
}
```

Also available server-wide via env (`WHATSAPP_HOOK_URL`, `WHATSAPP_HOOK_EVENTS`, `WHATSAPP_HOOK_HMAC_KEY`,
`WHATSAPP_HOOK_RETRIES_*`, `WHATSAPP_HOOK_CUSTOM_HEADERS`); global config is not visible in `GET /api/sessions`.
`config.ignore.{status,groups,channels,broadcast}` suppresses webhooks for those chats — group triage needs
`groups` not ignored. Unknown event names are ignored with a warning.

### 2.2 Envelope (`populateSessionInfo`, `src/core/abc/manager.abc.ts`)

```jsonc
{
  "id": "evt_…",            // event id (ULID-like) — use for dedupe
  "timestamp": 1794925889000, // ms
  "event": "message.any",
  "session": "default",
  "metadata": { "tenant": "t1" },   // session config.metadata, echoed
  "me": { "id": "519…@c.us", "pushName": "…" },
  "payload": { … },
  "engine": "GOWS",
  "environment": { "version": "2026.9.2", … }
}
```

Message `payload` (GOWS `toWAMessage` + media from `processIncomingMessage`):

```jsonc
{
  "id": "false_51900000002@c.us_3EB0AAAA",
  "timestamp": 1794925889,              // seconds
  "from": "51900000002@c.us",           // = Info.Chat (the chat, also for fromMe); may be "…@lid"
  "fromMe": false,
  "source": "app",                      // "app" | "api" (api = sent by WAHA's own device)
  "body": "hola",
  "to": null, "participant": null,      // set to the sender only in groups
  "hasMedia": false,
  "media": null,                        // { url, mimetype, filename, error } after WAHA downloads it
  "ack": 2, "ackName": "DEVICE",
  "location": null, "vCards": [], "replyTo": null,
  "_data": { "Info": { "Chat": "…", "Sender": "…", "SenderAlt": "…", "IsFromMe": false, "ID": "…",
                       "PushName": "…", "Timestamp": "…", … },
             "Message": { "conversation": "hola" }, … }
}
```

Session-status `payload`:

```json
{ "name": "default", "status": "WORKING",
  "statuses": [{ "status": "STARTING", "timestamp": 1794925800000 }, { "status": "WORKING", "timestamp": 1794925805000 }],
  "data": null }
```

### 2.3 Webhook payload vs the existing GOWS mapper

The webhook message payload is built by the same `toWAMessage` that backs the REST `/messages` responses the
mapper already handles; its keys match `test/fixtures/gows/messages-text.json` one for one
(`id, timestamp, from, fromMe, source, body, to, participant, hasMedia, media, ack, location, vCards, ackName,
replyTo, _data{Info, Message, …}`). Field-by-field, what `gowsMapper.message` reads:

| Mapper reads | Webhook payload | OK |
|---|---|---|
| `_data.Message` (object, required) | present | yes |
| `_data.Info.Sender` / `SenderAlt` / `PushName` / `IsFromMe` / `Chat` | present | yes |
| `id`, `timestamp` (s), `fromMe`, `from`, `participant` | present | yes |
| `media.mimetype`, `media.filename` (fallbacks) | present after download | yes |
| `replyTo.id` | present when replying | yes |

Synthetic check (scratch script, fake numbers): incoming text, `fromMe` from phone, `fromMe` via API, incoming
PDF document, and an `@lid` sender all mapped correctly (`type`, `fromMe`, `text`, `author.phone` via
`SenderAlt` for `@lid`, attachment kind/mimetype/filename/size, `mediaId`). Gaps for missions: the
`NormalizedMessage` carries **no chat id and no `source`** — the webhook route must read `payload.from` and
`payload.source` from the raw payload next to the mapper output.

## 3. Decisions for later tasks

1. **Server notices go as `role: "system"` messages** appended to `messages` (after a user turn, last or
   followed by an assistant turn). No tagged-user-text workaround needed.
2. **Provider field shape:** keep `provider: { order: ["anthropic"], allow_fallbacks: true }` (accepted and
   honored). Record the serving provider from the response body's top-level `provider` string; no
   `/generation` call in the hot path.
3. **Cost:** `usage.cost` is USD (number) — store it as `costUsd` as the client already does; it already
   includes cache-read/write pricing. Optionally also store `output_tokens_details.thinking_tokens`.
4. **Caching:** put `cache_control` on the stable system prompt (and on the last history block for long
   missions); cache reads work through OpenRouter as long as the same provider serves.
5. **Images and PDFs:** send as base64 `image` / `document` blocks; both work.
6. **`finish_mission`:** `strict: true` + `tool_choice: auto` works; never use forced `tool_choice`.
7. **History:** append assistant `content` exactly as returned (thinking blocks included).
8. **Webhook events:** subscribe `["message.any", "session.status"]` only. `message.any` already carries
   incoming messages; adding `message` would deliver every incoming message twice. Classify by
   `fromMe` + `source`: `false` → contact; `true`/`app` → owner typed on the phone (owner takeover);
   `true`/`api` → our own send (dedupe against the ids `sendText` returned).
9. **Signature verification:** HMAC-SHA512 over the **raw request body bytes** with `WAHA_WEBHOOK_SECRET`,
   hex, compared in constant time against `X-Webhook-Hmac`; reject if the header is missing. Do not trust
   `X-Webhook-Timestamp` (unsigned); use the signed body `timestamp` for a freshness window and `id` (`evt_…`)
   for dedupe/replay protection.
10. **Webhook responses:** ack fast (2xx) and process asynchronously; return 2xx for unknown events/sessions,
    because WAHA retries every non-2xx (including 401) 15 times. Do not assume event ordering.
11. **Tenant routing:** identify the tenant by envelope `session` (= `tenant.wahaSession`), cross-checked with
    `metadata.tenant`.
12. **Registration (T4):** set the webhook when the session is created where possible; for existing sessions
    GET config → merge → PUT, accepting one session restart.
13. **Chat ids:** `payload.from` may be `@lid`; mission chat matching must accept both the `@c.us` id and the
    `@lid` id (use `_data.Info.SenderAlt` / `Chat`), never only one form.

## 4. Open items to confirm live (T4/T11)

- Whether GOWS 2026.9.2 emits `message.any` for messages sent through `/api/sendText` (and with `source:"api"`).
- That `PUT /api/sessions/{name}` restarts a WORKING GOWS session and fully replaces `config`.
- That `hmac`/`retries` are honored on the deployed WAHA tier, and the exact hex signature over the raw body.
- Real `@lid` vs `@c.us` forms of `from` for direct chats on the owner's account.
- `media.url` availability timing for incoming images/PDFs (WAHA downloads before emitting the event).
