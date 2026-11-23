export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Sends transactional email (password resets). Failures throw `EmailSendError`. */
export interface EmailSender {
  send(email: OutgoingEmail): Promise<void>;
}
