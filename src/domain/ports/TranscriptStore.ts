/** Voice-note transcripts, keyed by chat id and WAHA message id; paid for once per message. */
export interface TranscriptStore {
  get(chatId: string, messageId: string): string | null;
  put(chatId: string, messageId: string, text: string): void;
  /** Deletes the transcript of the message with this short id, whatever chat it is filed under. */
  deleteByShortId(shortId: string): void;
  /** The account the stored rows belong to (`<session>|<me.id>`); shared with the message cache. */
  getOwner(): string | null;
  /** Wipes every transcript AND every cached message, then records `owner` (one transaction). */
  resetForOwner(owner: string): void;
}
