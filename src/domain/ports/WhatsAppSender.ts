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
}
