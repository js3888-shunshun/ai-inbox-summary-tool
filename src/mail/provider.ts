import type { EmailMessage } from "../domain/types.js";

/**
 * Clean seam over the email provider (Nylas). The rest of the app depends only
 * on this interface, so Nylas can be swapped or faked in tests — a live mailbox
 * is never required to exercise our own logic.
 */
export interface MailProvider {
  /** Build the hosted-OAuth URL to redirect the user to. */
  authUrl(redirectUri: string, state?: string): string;

  /** Exchange the OAuth `code` for a grant. */
  exchangeCode(code: string, redirectUri: string): Promise<{ grantId: string; email: string }>;

  /**
   * Read recent inbox messages for a grant. `limit` bounds the pull; pass a
   * `receivedAfter` (unix seconds) to fetch only new mail instead of the whole box.
   */
  listMessages(
    grantId: string,
    opts: { limit: number; receivedAfter?: number },
  ): Promise<EmailMessage[]>;

  /** Fetch a single full message (used when a webhook payload is truncated). */
  getMessage(grantId: string, messageId: string): Promise<EmailMessage>;

  /** Send the digest email to an arbitrary destination address. */
  sendEmail(
    grantId: string,
    msg: { to: string; subject: string; body: string },
  ): Promise<void>;

  /** Revoke a grant on the provider (used when disconnecting a mailbox). */
  revokeGrant(grantId: string): Promise<void>;
}
