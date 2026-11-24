/** A file held in memory, sent to WAHA as base64. */
export interface OutgoingFile {
  data: Uint8Array;
  mimetype: string;
  filename: string;
}

/** Either bytes the server holds or a public URL WAHA downloads itself. */
export type FileSource = OutgoingFile | { url: string; mimetype: string; filename: string };

export interface SentMessage {
  id: string;
  /** Unix seconds, when WAHA reports it. */
  timestamp: number | null;
  /** True when an earlier send with unknown outcome had already delivered it; nothing was sent now. */
  alreadySent?: true;
}

interface Target {
  chatId: string;
  /** Id of the message to quote. */
  replyTo?: string;
}

/**
 * Write access to WhatsApp through WAHA, kept apart from the read-only `WahaGateway`.
 * A failure before WAHA answers throws `SendOutcomeUnknownError`: never retry blindly.
 */
export interface WhatsAppSender {
  sendText(q: Target & { text: string; mentions?: string[] }): Promise<SentMessage>;
  sendImage(q: Target & { file: FileSource; caption?: string }): Promise<SentMessage>;
  sendVideo(q: Target & { file: FileSource; caption?: string }): Promise<SentMessage>;
  sendFile(q: Target & { file: FileSource; caption?: string }): Promise<SentMessage>;
  sendVoice(q: Target & { file: FileSource }): Promise<SentMessage>;
  sendLocation(
    q: Target & { latitude: number; longitude: number; title?: string },
  ): Promise<SentMessage>;
  sendContact(
    q: Target & { fullName: string; phoneNumber: string; organization?: string },
  ): Promise<SentMessage>;
  sendPoll(
    q: Target & { question: string; options: string[]; multipleAnswers: boolean },
  ): Promise<SentMessage>;
  /** Marks messages as read; without ids WAHA marks the whole chat. */
  sendSeen(q: { chatId: string; messageIds?: string[] }): Promise<void>;
  /** Reacts to a message by its full id; an empty emoji removes the owner's reaction. */
  react(q: { messageId: string; emoji: string }): Promise<void>;
  /** Replaces the text of one of the owner's own messages (full id). */
  editMessage(q: { chatId: string; messageId: string; text: string }): Promise<void>;
  /** Deletes one of the owner's own messages for everyone (full id). */
  deleteMessage(q: { chatId: string; messageId: string }): Promise<void>;
  /** Marks a whole chat as read (WAHA defaults for which messages). */
  markRead(chatId: string): Promise<void>;
  /** Marks a chat as unread. */
  markUnread(chatId: string): Promise<void>;
  startTyping(chatId: string): Promise<void>;
  stopTyping(chatId: string): Promise<void>;
}
