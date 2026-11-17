import type Anthropic from "@anthropic-ai/sdk";

/**
 * The agent's tools (strict schemas; the client sends `tool_choice: auto`). Replying is plain
 * assistant text; staying silent is the explicit `no_reply`.
 */
export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "finish_mission",
    description:
      "End the mission. Use it only when the objective is met (succeeded) or clearly cannot be met (failed). Any text in the same turn is sent to the contact first.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["succeeded", "failed"] },
        summary: {
          type: "string",
          description: "One or two sentences for the owner: what was agreed or why it failed.",
        },
        collected: {
          type: "array",
          description: "Data or files gathered for the owner.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              media_id: { type: "string", description: "The media_id of a file the contact sent." },
              value: { type: "string" },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
      },
      required: ["outcome", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_owner",
    description:
      "Ask the owner something you cannot answer from your instructions. Tell the contact you will check and keep working on the rest; the answer arrives later as a system message.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "no_reply",
    description: "Send nothing this turn (for example after a plain acknowledgement).",
    strict: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export interface CollectedItem {
  label: string;
  media_id?: string;
  value?: string;
}

export interface AgentTurn {
  /** Text blocks joined; empty when the agent wrote nothing. */
  reply: string;
  finish: { outcome: "succeeded" | "failed"; summary: string; collected: CollectedItem[] } | null;
  question: string | null;
  noReply: boolean;
  /** One result per tool call, to open the next user turn. */
  toolResults: Anthropic.ToolResultBlockParam[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function collectedOf(v: unknown): CollectedItem[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRecord).flatMap((i): CollectedItem[] =>
    typeof i.label === "string"
      ? [
          {
            label: i.label,
            ...(typeof i.media_id === "string" ? { media_id: i.media_id } : {}),
            ...(typeof i.value === "string" ? { value: i.value } : {}),
          },
        ]
      : [],
  );
}

/** Reads one assistant turn: the reply text and the tool calls (validated again here). */
export function parseAgentTurn(content: Anthropic.ContentBlock[]): AgentTurn {
  const turn: AgentTurn = {
    reply: "",
    finish: null,
    question: null,
    noReply: false,
    toolResults: [],
  };
  const texts: string[] = [];
  const result = (id: string, text: string, isError = false): void => {
    turn.toolResults.push({
      type: "tool_result",
      tool_use_id: id,
      content: text,
      ...(isError ? { is_error: true } : {}),
    });
  };
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text);
      continue;
    }
    if (block.type !== "tool_use") continue;
    const input = isRecord(block.input) ? block.input : {};
    if (block.name === "finish_mission") {
      const outcome = input.outcome;
      if ((outcome === "succeeded" || outcome === "failed") && typeof input.summary === "string") {
        turn.finish = { outcome, summary: input.summary, collected: collectedOf(input.collected) };
        result(block.id, "Mission closed.");
      } else result(block.id, "Invalid input: outcome and summary are required.", true);
    } else if (block.name === "ask_owner") {
      if (typeof input.question === "string" && input.question.trim() !== "") {
        turn.question = input.question.trim();
        result(
          block.id,
          "Question sent to the owner. Their answer will arrive as a system message; keep working on the rest meanwhile.",
        );
      } else result(block.id, "Invalid input: question is required.", true);
    } else if (block.name === "no_reply") {
      turn.noReply = true;
      result(block.id, "Nothing was sent.");
    } else {
      result(block.id, `Unknown tool: ${block.name}.`, true);
    }
  }
  turn.reply = texts
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .join("\n\n");
  return turn;
}
