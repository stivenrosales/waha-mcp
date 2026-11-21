import { InvalidInputError } from "../domain/errors.js";
import type { EngineMapper } from "../domain/message.js";
import { parseMessageId } from "../domain/messageId.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";
import { joinKey, loadContacts } from "./groups.js";
import type { MessageActions } from "./messageActions.js";

export interface PollResults {
  question: string;
  /** Poll order. */
  options: { option: string; votes: number }[];
  /** Newest vote first; `"me"` is the owner. Voters who cleared their vote are left out. */
  voters: { id: string; name: string | null; options: string[] }[];
  /** Voters whose latest vote could not be decrypted. */
  failedVotes: number;
  webhooks: boolean;
}

/**
 * Question, options and the votes received through webhooks. Votes are only known from when the
 * server started receiving them. Without webhooks the options come back with zero counts.
 */
export async function getPollResults(
  deps: {
    gateway: WahaGateway;
    mapper: EngineMapper;
    actions: MessageActions;
    webhooksOn: boolean;
    now: () => number;
  },
  messageId: string,
): Promise<PollResults> {
  const parsed = parseMessageId(messageId);
  const message = deps.mapper.message(await deps.gateway.getMessage(parsed.chatId, messageId));
  if (message.type !== "poll" || message.poll === null)
    throw new InvalidInputError("That message is not a poll.");
  const { question, options } = message.poll;
  if (!deps.webhooksOn)
    return {
      question,
      options: options.map((option) => ({ option, votes: 0 })),
      voters: [],
      failedVotes: 0,
      webhooks: false,
    };

  const { votes, failed } = await deps.actions.pollVotes(parsed.shortId);
  const current = votes.filter((v) => v.options.length > 0).sort((a, b) => b.ts - a.ts);
  const counts = new Map(options.map((o) => [o, 0]));
  for (const v of current)
    for (const o of new Set(v.options)) if (counts.has(o)) counts.set(o, (counts.get(o) ?? 0) + 1);

  // Names are best-effort: a failing lookup leaves voters unnamed instead of failing the read.
  let names = new Map<string, string | null>();
  try {
    const contacts = await loadContacts(deps.gateway, deps.now());
    const me = (await deps.gateway.getMe()).id;
    const nameOf = (id: string) => {
      const c = contacts.get(joinKey(id === "me" ? me : id));
      return c?.name ?? c?.pushname ?? null;
    };
    names = new Map(current.map((v) => [v.voter, nameOf(v.voter)]));
  } catch {
    // unnamed
  }
  return {
    question,
    options: options.map((option) => ({ option, votes: counts.get(option) ?? 0 })),
    voters: current.map((v) => ({
      id: v.voter,
      name: names.get(v.voter) ?? null,
      options: v.options,
    })),
    failedVotes: failed,
    webhooks: true,
  };
}
