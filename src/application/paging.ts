// Guards against a gateway that never returns a short page.
const MAX_PAGES = 100;

/**
 * Reads an offset-paged list. Stops after an empty page or a short one (fewer than `limit`
 * items): WAHA answers HTTP 500, not `[]`, when the offset is past the end, so the page after
 * a short page must never be requested.
 */
export async function pageAll(
  fetchPage: (q: { limit: number; offset: number }) => Promise<unknown[]>,
  limit: number,
): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const items = await fetchPage({ limit, offset: page * limit });
    all.push(...items);
    if (items.length < limit) break;
  }
  return all;
}
