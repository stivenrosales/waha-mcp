import { InvalidInputError } from "../domain/errors.js";
import type { EngineMapper } from "../domain/message.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";
import { joinKey, listChats, loadContacts } from "./groups.js";
import { fold } from "./search.js";

const MAX_CANDIDATES = 10;
const MIN_NAME = 2;
const MIN_DIGITS = 6;
/** Shortest number matched by its ending (a 9-digit local number is fine, 7 is too loose). */
const MIN_SUFFIX_DIGITS = 8;
const MAX_DIGITS = 15;

export interface ContactCard {
  /** Phone jid when known, otherwise the lid. */
  id: string;
  lid: string | null;
  phone: string | null;
  name: string | null;
  pushname: string | null;
  groupsInCommon: { id: string; name: string }[];
  lastInteraction: string | null;
}

export interface ContactCandidate {
  id: string;
  phone: string | null;
  name: string | null;
  pushname: string | null;
}

export interface ContactResult {
  /** `unique`: `contact` is set; `ambiguous`/`none` (name search only): see `candidates`. */
  match: "unique" | "ambiguous" | "none";
  contact: ContactCard | null;
  candidates: ContactCandidate[];
  /** Name matches before the cap of 10. */
  totalCandidates: number;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Device suffixes are dropped and `@s.whatsapp.net` becomes `@c.us`. */
const canon = (jid: string) => joinKey(jid.replace(/:\d+@/, "@"));
const phoneOf = (id: string): string | null => /^(\d+)@c\.us$/.exec(id)?.[1] ?? null;
const isLid = (id: string) => id.endsWith("@lid");

interface Identity {
  phoneId: string | null;
  lid: string | null;
}

function parseTarget(q: { contactId?: string; phone?: string }): Identity {
  if (q.phone !== undefined) {
    const digits = q.phone.replace(/\D/g, "");
    if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS)
      throw new InvalidInputError(
        `"phone" must hold ${MIN_DIGITS}-${MAX_DIGITS} digits (e.g. "+51 987 654 321").`,
      );
    return { phoneId: `${digits}@c.us`, lid: null };
  }
  const id = canon((q.contactId as string).trim());
  if (isLid(id)) return { phoneId: null, lid: id };
  if (phoneOf(id)) return { phoneId: id, lid: null };
  throw new InvalidInputError(
    '"contactId" must be a phone id ("…@c.us") or a lid ("…@lid"); groups are not contacts.',
  );
}

interface Participant {
  ids: string[];
}

/** Every id a group member is known by (JID, phone number, LID), canonicalized. */
function participantsOf(raw: unknown): Participant[] {
  const list = asRecord(raw).Participants;
  if (!Array.isArray(list)) return [];
  return list.map((p) => {
    const o = asRecord(p);
    return {
      ids: [o.JID, o.PhoneNumber, o.LID]
        .map(str)
        .filter((v): v is string => v !== null)
        .map(canon),
    };
  });
}

/**
 * A contact card from what WAHA already exposes: the address book, the group list's
 * participants (no per-group fetch), the chats list and, for a `@lid` target, one
 * lid→phone lookup (non-fatal when it fails). Name search never guesses.
 */
export async function getContact(
  gw: WahaGateway,
  m: EngineMapper,
  q: { contactId?: string; phone?: string; name?: string },
  deps: { now?: () => number } = {},
): Promise<ContactResult> {
  const given = [q.contactId, q.phone, q.name].filter((v) => v !== undefined);
  if (given.length !== 1)
    throw new InvalidInputError('Give exactly one of "contactId", "phone" or "name".');
  const now = (deps.now ?? Date.now)();

  const contacts = await loadContacts(gw, now);

  if (q.name !== undefined) {
    const needle = fold(q.name.trim()).folded;
    if (Array.from(needle).length < MIN_NAME)
      throw new InvalidInputError(`"name" must have at least ${MIN_NAME} characters.`);
    const found = [...contacts]
      .filter(
        ([, c]) =>
          (c.name !== null && fold(c.name).folded.includes(needle)) ||
          (c.pushname !== null && fold(c.pushname).folded.includes(needle)),
      )
      .map(([id, c]) => ({ id, phone: phoneOf(id), name: c.name, pushname: c.pushname }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const only = found.length === 1 ? found[0] : undefined;
    if (only) return card(gw, m, { id: only.id }, contacts, now);
    return {
      match: found.length === 0 ? "none" : "ambiguous",
      contact: null,
      candidates: found.slice(0, MAX_CANDIDATES),
      totalCandidates: found.length,
    };
  }
  const target = parseTarget(q);
  if (q.phone === undefined) return card(gw, m, target, contacts, now);

  // Phone: exact digits first, then (8+ digits) a match by ending, so a local number finds
  // its country-code form. No country code is ever guessed.
  const world = await loadWorld(gw, m, now);
  const digits = phoneOf(target.phoneId as string) as string;
  const known = new Set<string>();
  const add = (id: string) => {
    const p = phoneOf(id);
    if (p) known.add(p);
  };
  for (const id of contacts.keys()) add(id);
  for (const g of world.groups) for (const p of g.members) for (const id of p.ids) add(id);
  for (const c of world.chats) add(canon(c.id));
  if (known.has(digits)) return card(gw, m, target, contacts, now, world);
  const hits =
    digits.length >= MIN_SUFFIX_DIGITS
      ? [...known].filter((p) => p.length > digits.length && p.endsWith(digits)).sort()
      : [];
  const only = hits.length === 1 ? hits[0] : undefined;
  if (only) return card(gw, m, { phoneId: `${only}@c.us`, lid: null }, contacts, now, world);
  return {
    match: hits.length === 0 ? "none" : "ambiguous",
    contact: null,
    candidates: hits.slice(0, MAX_CANDIDATES).map((p) => {
      const c = contacts.get(`${p}@c.us`);
      return { id: `${p}@c.us`, phone: p, name: c?.name ?? null, pushname: c?.pushname ?? null };
    }),
    totalCandidates: hits.length,
  };
}

interface World {
  groups: { summary: { id: string; name: string }; members: Participant[] }[];
  chats: { id: string; lastActivity: string | null }[];
}

/** The group list and the direct chats, each fetched once per call. */
async function loadWorld(gw: WahaGateway, m: EngineMapper, now: number): Promise<World> {
  const groups = (await gw.listGroups()).map((raw) => ({
    summary: m.groupSummary(raw),
    members: participantsOf(raw),
  }));
  // Best effort: a failing chats list must not hide the rest of the card.
  const chats = await listChats(gw, m, {}, { now: () => now }).then(
    (r) => r.chats,
    () => [],
  );
  return { groups, chats };
}

type Target = Identity | { id: string };

async function card(
  gw: WahaGateway,
  m: EngineMapper,
  target: Target,
  contacts: Awaited<ReturnType<typeof loadContacts>>,
  now: number,
  preloaded?: World,
): Promise<ContactResult> {
  const start: Identity =
    "id" in target
      ? isLid(target.id)
        ? { phoneId: null, lid: target.id }
        : { phoneId: target.id, lid: null }
      : target;
  let { phoneId, lid } = start;
  if (phoneId === null && lid !== null) {
    try {
      const pn = await gw.lookupLid(lid);
      if (pn) phoneId = canon(pn);
    } catch {
      // Non-fatal: the contact is then matched by its lid only.
    }
  }

  // Group participants carry both ids: one pass learns the missing id, the next matches.
  const world = preloaded ?? (await loadWorld(gw, m, now));
  const groups = world.groups;
  const known = () => new Set([phoneId, lid].filter((v): v is string => v !== null));
  for (const g of groups)
    for (const p of g.members)
      if (p.ids.some((id) => known().has(id))) {
        phoneId ??= p.ids.find((id) => phoneOf(id) !== null) ?? null;
        lid ??= p.ids.find(isLid) ?? null;
      }
  const ids = known();
  const groupsInCommon = groups
    .filter((g) => g.members.some((p) => p.ids.some((id) => ids.has(id))))
    .map((g) => ({ id: g.summary.id, name: g.summary.name }));

  const book = [phoneId, lid].map((id) => (id ? contacts.get(id) : undefined));
  const name = book.find((c) => c?.name)?.name ?? null;
  const pushname = book.find((c) => c?.pushname)?.pushname ?? null;

  // The chats list may know the person under either id; keep the most recent activity.
  let lastInteraction: string | null = null;
  for (const c of world.chats)
    if (
      ids.has(canon(c.id)) &&
      c.lastActivity &&
      (!lastInteraction || c.lastActivity > lastInteraction)
    )
      lastInteraction = c.lastActivity;

  const id = (phoneId ?? lid) as string;
  return {
    match: "unique",
    contact: {
      id,
      lid,
      phone: phoneId ? phoneOf(phoneId) : null,
      name,
      pushname,
      groupsInCommon,
      lastInteraction,
    },
    candidates: [],
    totalCandidates: 0,
  };
}
