import type { WahaGateway } from "../domain/ports/WahaGateway.js";

/** Where `cache.db` records the account its rows belong to (shared by every store in the file). */
export interface OwnerRecord {
  getOwner(): string | null;
  /** Wipes every cached message, transcript and message action, then records `owner`. */
  resetForOwner(owner: string): void;
}

/**
 * Resolves the account (`<session>|<getMe().id>`) once per process and wipes `cache.db` when it
 * belongs to another (or no recorded) account. Concurrent callers share the pending lookup; a
 * failed `getMe` rejects and is retried on the next call. Share one instance between everything
 * that reads or writes the same database, so the wipe happens before any of them touches it.
 */
export function createOwnerCheck(
  gw: Pick<WahaGateway, "getMe">,
  store: OwnerRecord,
  session: string,
): () => Promise<void> {
  let checked = false;
  let pending: Promise<void> | null = null;
  return () => {
    if (checked) return Promise.resolve();
    pending ??= gw
      .getMe()
      .then((me) => {
        const owner = `${session}|${me.id}`;
        if (store.getOwner() !== owner) store.resetForOwner(owner);
        checked = true;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
