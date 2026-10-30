/** Speech-to-text provider. Throws `TranscriptionError` (fixed messages) on failure. */
export interface Transcriber {
  transcribe(audio: { bytes: Uint8Array; mimetype: string; filename: string }): Promise<string>;
}
