import Nylas from "nylas";
import type { Message } from "nylas";
import type { MailProvider } from "./provider.js";
import type { EmailMessage } from "../domain/types.js";
import type { Config } from "../config.js";

/** Map a Nylas Message into our provider-agnostic EmailMessage. */
export function toEmailMessage(m: Message): EmailMessage {
  const sender = m.from?.[0];
  return {
    id: m.id,
    grantId: m.grantId,
    threadId: m.threadId ?? null,
    from: sender?.name?.trim() || sender?.email || "(unknown sender)",
    fromEmail: sender?.email ?? "",
    subject: m.subject?.trim() || "(no subject)",
    snippet: m.snippet ?? "",
    receivedAt: m.date,
    unread: m.unread ?? false,
  };
}

/**
 * Nylas-backed implementation of MailProvider. This is the only file that knows
 * about the Nylas SDK; everything else depends on the MailProvider interface.
 */
export class NylasMailProvider implements MailProvider {
  private readonly nylas: InstanceType<typeof Nylas>;
  private readonly clientId: string;
  private readonly apiKey: string;

  constructor(cfg: Config["nylas"]) {
    this.nylas = new Nylas({ apiKey: cfg.apiKey, apiUri: cfg.apiUri });
    this.clientId = cfg.clientId;
    this.apiKey = cfg.apiKey;
  }

  authUrl(redirectUri: string, state?: string): string {
    return this.nylas.auth.urlForOAuth2({
      clientId: this.clientId,
      redirectUri,
      ...(state !== undefined ? { state } : {}),
    });
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{ grantId: string; email: string }> {
    const res = await this.nylas.auth.exchangeCodeForToken({
      clientId: this.clientId,
      clientSecret: this.apiKey,
      code,
      redirectUri,
    });
    return { grantId: res.grantId, email: res.email ?? "" };
  }

  /**
   * Read recent INBOX messages. Bounded by `limit` (single page) and optionally
   * `receivedAfter` so the scheduler pulls only mail since the last digest
   * rather than refetching the whole mailbox.
   */
  async listMessages(
    grantId: string,
    opts: { limit: number; receivedAfter?: number },
  ): Promise<EmailMessage[]> {
    const res = await this.nylas.messages.list({
      identifier: grantId,
      queryParams: {
        limit: opts.limit,
        in: ["INBOX"],
        ...(opts.receivedAfter !== undefined ? { receivedAfter: opts.receivedAfter } : {}),
      },
    });
    return res.data.map(toEmailMessage);
  }

  /** Fetch one full message — used to recover from truncated webhook payloads. */
  async getMessage(grantId: string, messageId: string): Promise<EmailMessage> {
    const res = await this.nylas.messages.find({ identifier: grantId, messageId });
    return toEmailMessage(res.data);
  }

  sendEmail(): Promise<void> {
    throw new Error("NylasMailProvider.sendEmail not implemented yet (M4)");
  }
}
