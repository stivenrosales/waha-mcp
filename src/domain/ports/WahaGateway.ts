export interface OpenedFile {
  body: ReadableStream<Uint8Array>;
  mimetype: string;
  length: number | null;
}

/** Read-only access to WAHA. Payloads are raw engine data; mapping happens elsewhere. */
export interface WahaGateway {
  getSession(): Promise<{ engine: string; status: string }>;
  /** The account owner. `id` is the phone JID (`…@c.us`); `lid` the linked id when WAHA reports one. Cached per process. */
  getMe(): Promise<{ id: string; lid: string | null }>;
  /** Phone jid (`…@c.us`) behind a `@lid`, or null when WAHA has no mapping. */
  lookupLid(lid: string): Promise<string | null>;
  listGroups(): Promise<unknown[]>;
  getGroup(groupId: string): Promise<unknown>;
  /** All chat types (groups, direct, newsletters...); filtering happens in the use case. */
  listChats(q: { limit: number; offset: number }): Promise<unknown[]>;
  /** Address-book contacts; `name` is the saved name, `pushname` the self-chosen one. */
  listContacts(q: { limit: number; offset: number }): Promise<unknown[]>;
  /** `from` / `to` are unix seconds. */
  getMessages(
    chatId: string,
    q: { limit: number; offset: number; from?: number; to?: number },
  ): Promise<unknown[]>;
  /** One message with its media URL resolved (`downloadMedia=true`). 404 → WahaNotFoundError. */
  getMessage(chatId: string, messageId: string): Promise<unknown>;
  /**
   * Opens a WAHA file without reading it. `null` means the media is gone (404/410).
   * `length` is the declared Content-Length (`null` when absent or invalid); the
   * caller must consume or cancel `body`.
   */
  openMedia(url: string): Promise<OpenedFile | null>;
}
