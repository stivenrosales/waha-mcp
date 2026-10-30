import type { ChatSummary, EngineMapper, GroupInfo, GroupSummary } from "../domain/message.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";

/** Newest first; entries without a known activity time go last. */
function byActivityDesc<T extends { lastActivity: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.lastActivity === b.lastActivity) return 0;
    if (a.lastActivity === null) return 1;
    if (b.lastActivity === null) return -1;
    return a.lastActivity < b.lastActivity ? 1 : -1;
  });
}

export async function listGroups(
  gw: WahaGateway,
  m: EngineMapper,
  q: { nameContains?: string },
): Promise<GroupSummary[]> {
  const needle = q.nameContains?.trim().toLowerCase();
  const groups = (await gw.listGroups()).map((raw) => m.groupSummary(raw));
  const filtered = needle ? groups.filter((g) => g.name.toLowerCase().includes(needle)) : groups;
  // The groups endpoint has no activity time; the chats list does. Best-effort merge.
  const activity = await groupActivity(gw, m).catch(() => new Map<string, string>());
  return byActivityDesc(
    filtered.map((g) => ({ ...g, lastActivity: g.lastActivity ?? activity.get(g.id) ?? null })),
  );
}

async function groupActivity(gw: WahaGateway, m: EngineMapper): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const raw of await fetchAllChats(gw)) {
    const c = m.chatSummary(raw);
    if (c.id.endsWith("@g.us") && c.lastActivity) out.set(c.id, c.lastActivity);
  }
  return out;
}

async function fetchAllChats(gw: WahaGateway): Promise<unknown[]> {
  const raws: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const items = await gw.listChats({ limit: CHAT_PAGE, offset: page * CHAT_PAGE });
    if (items.length === 0) break;
    raws.push(...items);
  }
  return raws;
}

export async function getGroupInfo(
  gw: WahaGateway,
  m: EngineMapper,
  groupId: string,
): Promise<GroupInfo> {
  return m.groupInfo(await gw.getGroup(groupId));
}

// --- direct chats ---------------------------------------------------------------

const DIRECT_SUFFIXES = ["@c.us", "@s.whatsapp.net", "@lid"];
const isDirectChatId = (id: string) => DIRECT_SUFFIXES.some((s) => id.endsWith(s));

const CHAT_PAGE = 500;
const CONTACT_PAGE = 5000;
// Guards against a gateway that never returns an empty page.
const MAX_PAGES = 100;
const CONTACTS_TTL_MS = 10 * 60_000;

interface ContactNames {
  name: string | null;
  pushname: string | null;
}
interface CacheEntry {
  loadedAt: number;
  byId: Map<string, ContactNames>;
}
const contactCache = new WeakMap<WahaGateway, CacheEntry>();

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const nonEmpty = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;
/** WAHA ids come as a plain string or as `{ _serialized }`. */
const idOf = (v: unknown): string | null => nonEmpty(v) ?? nonEmpty(asRecord(v)._serialized);
/** Contacts are listed as `@c.us`; chats may use the equivalent `@s.whatsapp.net`. */
const joinKey = (id: string) => id.replace(/@s\.whatsapp\.net$/, "@c.us");

async function loadContacts(gw: WahaGateway, now: number): Promise<Map<string, ContactNames>> {
  const cached = contactCache.get(gw);
  if (cached && now - cached.loadedAt < CONTACTS_TTL_MS) return cached.byId;
  const byId = new Map<string, ContactNames>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const items = await gw.listContacts({ limit: CONTACT_PAGE, offset: page * CONTACT_PAGE });
    if (items.length === 0) break;
    for (const item of items) {
      const c = asRecord(item);
      const id = idOf(c.id);
      if (id) byId.set(joinKey(id), { name: nonEmpty(c.name), pushname: nonEmpty(c.pushname) });
    }
  }
  contactCache.set(gw, { loadedAt: now, byId });
  return byId;
}

/** Direct (1:1) chats only, with names resolved from the address book. Newest activity first. */
export async function listChats(
  gw: WahaGateway,
  m: EngineMapper,
  q: { nameContains?: string },
  deps: { now?: () => number } = {},
): Promise<{ chats: ChatSummary[]; namesResolved: boolean }> {
  const now = (deps.now ?? Date.now)();
  const raws = await fetchAllChats(gw);
  const direct = raws.map((raw) => m.chatSummary(raw)).filter((c) => isDirectChatId(c.id));
  // Names are best-effort: a failing contacts load must not hide the chats (and is not cached).
  let namesResolved = true;
  let contacts = new Map<string, ContactNames>();
  try {
    contacts = await loadContacts(gw, now);
  } catch {
    namesResolved = false;
  }
  const named = direct.map((c) => {
    const contact = contacts.get(joinKey(c.id));
    return { ...c, name: contact?.name ?? contact?.pushname ?? c.name };
  });
  const needle = q.nameContains?.trim().toLowerCase();
  const filtered = needle
    ? named.filter(
        (c) =>
          (c.name?.toLowerCase().includes(needle) ?? false) ||
          (c.phone?.toLowerCase().includes(needle) ?? false),
      )
    : named;
  return { chats: byActivityDesc(filtered), namesResolved };
}
