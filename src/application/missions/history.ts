import type Anthropic from "@anthropic-ai/sdk";
import { shortMessageId } from "../../domain/messageId.js";
import type { MissionLog, MissionLogEntry } from "../../domain/ports/MissionLog.js";

/**
 * Shapes of the sealed mission log entries, and the rebuild of the append-only Messages API
 * history from them. The log is the only source of the conversation: a restarted engine rebuilds
 * exactly the `messages` the last call sent, so the prompt cache keeps hitting.
 *
 * - `prompt` `{ text }`: the system prompt Claude wrote in `start_mission`, sent verbatim.
 * - `spec` `{ objective, doneWhen, contactName }`: the first user turn.
 * - `message`: one `MessageBody` (below).
 * - `notice` `{ text }` and `answer` `{ text }`: server facts, sent as `role: "system"` messages.
 * - `sent` `{ id }`: a WhatsApp id the engine sent.
 * - `question` `{ question }`, `summary` `{ outcome, summary }`, `collected` (array): outcome
 *   records for the owner; never part of the history.
 */
export type MessageBody =
  /** One message from the contact, already turned into content blocks. */
  | { from: "contact"; id: string; content: Anthropic.ContentBlockParam[] }
  /** An engine instruction inside the user turn (opening, reminder, closing). */
  | { from: "engine"; text: string }
  /** The assistant turn exactly as the model returned it (thinking blocks included). */
  | { from: "agent"; content: Anthropic.ContentBlock[] }
  /** Results of the agent's tool calls; they open the next user turn. */
  | { from: "tool"; content: Anthropic.ToolResultBlockParam[] };

export interface MissionSpec {
  objective: string;
  doneWhen: string;
  /** How the owner notifications name the contact; the chat number when null. */
  contactName: string | null;
}

/** Writes what a new mission starts from; `start_mission` calls this right after `create`. */
export function startMissionContent(
  log: MissionLog,
  missionId: string,
  q: { systemPrompt: string; objective: string; doneWhen: string; contactName?: string | null },
  at: string,
): void {
  log.append(missionId, { kind: "prompt", at, body: { text: q.systemPrompt } });
  const spec: MissionSpec = {
    objective: q.objective,
    doneWhen: q.doneWhen,
    contactName: q.contactName ?? null,
  };
  log.append(missionId, { kind: "spec", at, body: spec });
}

export const ownerAnswerNotice = (text: string): string => `The owner answered: ${text}`;

const specText = (s: MissionSpec): string => `Objective: ${s.objective}\nDone when: ${s.doneWhen}`;

export { shortMessageId };

/** What arrived since the last agent turn (the input of the next one). */
export interface Pending {
  /** WhatsApp ids of the contact's messages (marked as seen before the reply). */
  contactIds: string[];
  /** Content blocks already in the open user turn (tool results, contact, instructions). */
  userBlocks: number;
  notices: string[];
  engineTexts: string[];
  answers: number;
}

export interface Conversation {
  system: string;
  spec: MissionSpec;
  messages: Anthropic.MessageParam[];
  agentTurns: number;
  pending: Pending;
  /** Short ids (see `shortMessageId`) of every message the engine sent. */
  sentIds: Set<string>;
  /** Short ids of every contact message already in the log (redelivery dedupe). */
  contactIds: Set<string>;
}

const emptyPending = (): Pending => ({
  contactIds: [],
  userBlocks: 0,
  notices: [],
  engineTexts: [],
  answers: 0,
});

const textBlock = (text: string): Anthropic.TextBlockParam => ({ type: "text", text });

/**
 * Rebuilds the conversation: user-side entries since the last agent turn form one user message,
 * followed by that stretch's notices as `role: "system"` messages, then the agent turn. The open
 * tail (no agent turn yet) is built the same way, so the result is the request to send.
 */
export function buildConversation(entries: MissionLogEntry[]): Conversation {
  let system = "";
  let spec: MissionSpec = { objective: "", doneWhen: "", contactName: null };
  const messages: Anthropic.MessageParam[] = [];
  const sentIds = new Set<string>();
  const contactIds = new Set<string>();
  let agentTurns = 0;
  let user: Anthropic.ContentBlockParam[] = [];
  let notices: string[] = [];
  let pending = emptyPending();

  const flush = (): void => {
    if (user.length > 0) messages.push({ role: "user", content: user });
    for (const n of notices) messages.push({ role: "system", content: n });
    user = [];
    notices = [];
  };

  for (const e of entries) {
    const body = e.body as Record<string, unknown>;
    switch (e.kind) {
      case "prompt":
        system = String(body.text ?? "");
        break;
      case "spec":
        spec = body as unknown as MissionSpec;
        user.push(textBlock(specText(spec)));
        pending.userBlocks += 1;
        break;
      case "notice":
        notices.push(String(body.text ?? ""));
        pending.notices.push(String(body.text ?? ""));
        break;
      case "answer":
        notices.push(ownerAnswerNotice(String(body.text ?? "")));
        pending.answers += 1;
        break;
      case "sent":
        sentIds.add(shortMessageId(String(body.id ?? "")));
        break;
      case "message": {
        const m = e.body as MessageBody;
        if (m.from === "agent") {
          flush();
          messages.push({ role: "assistant", content: m.content as Anthropic.ContentBlockParam[] });
          agentTurns += 1;
          pending = emptyPending();
        } else if (m.from === "contact") {
          user.push(...m.content);
          pending.contactIds.push(m.id);
          contactIds.add(shortMessageId(m.id));
          pending.userBlocks += m.content.length;
        } else if (m.from === "engine") {
          user.push(textBlock(m.text));
          pending.engineTexts.push(m.text);
          pending.userBlocks += 1;
        } else {
          user.push(...m.content);
          pending.userBlocks += m.content.length;
        }
        break;
      }
      default:
        // question, summary, collected: outcome records only.
        break;
    }
  }
  flush();
  return { system, spec, messages, agentTurns, pending, sentIds, contactIds };
}
