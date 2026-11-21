import type { EngineMapper, Reaction } from "../domain/message.js";
import { shortMessageId } from "../domain/messageId.js";
import type { MessageActionStore } from "../domain/ports/MessageActionStore.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";

const rawId = (raw: unknown): string | null => {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === "string" && id !== "" ? id : null;
};

/**
 * WAHA gateway that applies stored edits and revokes to every message it returns: a revoked
 * message becomes the engine's deleted payload (its text never leaves this layer), an edited one
 * carries the new text. WAHA keeps serving the original text after an edit, so this sits directly
 * on WAHA, below the message cache: refreshes, backfills and fallbacks all store and return the
 * rewritten payload. Rows without an override are returned as the same objects.
 *
 * Before reading the store it runs the owner check (which wipes a store left by another account).
 * When the check fails (WAHA has no owner right now) the overrides are still applied: hiding text
 * is always safe, and short ids of another account's messages never match these ones.
 */
export function withMessageActions(
  gw: WahaGateway,
  deps: {
    store: MessageActionStore;
    mapper: () => Promise<EngineMapper>;
    ensureOwner: () => Promise<void>;
  },
): WahaGateway {
  const { store } = deps;

  async function apply(raws: unknown[]): Promise<unknown[]> {
    await deps.ensureOwner().catch(() => {});
    const ids = new Set<string>();
    for (const raw of raws) {
      const id = rawId(raw);
      if (id) ids.add(shortMessageId(id));
    }
    if (ids.size === 0) return raws;
    const overrides = store.overrides([...ids]);
    if (overrides.size === 0) return raws;
    const mapper = await deps.mapper();
    return raws.map((raw) => {
      const id = rawId(raw);
      const o = id ? overrides.get(shortMessageId(id)) : undefined;
      if (!o) return raw;
      return o.kind === "revoked" ? mapper.revokedPayload(raw) : mapper.editedPayload(raw, o.text);
    });
  }

  return {
    getSession: () => gw.getSession(),
    getMe: () => gw.getMe(),
    lookupLid: (lid) => gw.lookupLid(lid),
    listGroups: () => gw.listGroups(),
    getGroup: (groupId) => gw.getGroup(groupId),
    listChats: (q) => gw.listChats(q),
    listContacts: (q) => gw.listContacts(q),
    openMedia: (url) => gw.openMedia(url),
    async getMessages(chatId, q) {
      return apply(await gw.getMessages(chatId, q));
    },
    async getMessage(chatId, messageId) {
      const [out] = await apply([await gw.getMessage(chatId, messageId)]);
      return out;
    },
    storedReactions: (shortIds): Map<string, Reaction[]> => store.reactions(shortIds),
  };
}
