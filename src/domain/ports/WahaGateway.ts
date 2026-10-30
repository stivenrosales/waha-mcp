/** Read-only access to WAHA. Payloads are raw engine data; mapping happens elsewhere. */
export interface WahaGateway {
  getSession(): Promise<{ engine: string; status: string }>;
  listGroups(): Promise<unknown[]>;
  getGroup(groupId: string): Promise<unknown>;
  /** `from` / `to` are unix seconds. */
  getMessages(
    chatId: string,
    q: { limit: number; offset: number; from?: number; to?: number },
  ): Promise<unknown[]>;
  /** `null` means the media is gone (404/410). */
  fetchMedia(url: string): Promise<{ bytes: Uint8Array; mimetype: string } | null>;
}
