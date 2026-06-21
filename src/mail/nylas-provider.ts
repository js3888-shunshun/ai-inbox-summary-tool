import Nylas from "nylas";
import type { MailProvider } from "./provider.js";
import type { EmailMessage } from "../domain/types.js";
import type { Config } from "../config.js";

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

  // ---- Implemented in M2 (read) / M3 (webhook refetch) / M4 (send) ----

  listMessages(): Promise<EmailMessage[]> {
    throw new Error("NylasMailProvider.listMessages not implemented yet (M2)");
  }

  getMessage(): Promise<EmailMessage> {
    throw new Error("NylasMailProvider.getMessage not implemented yet (M3)");
  }

  sendEmail(): Promise<void> {
    throw new Error("NylasMailProvider.sendEmail not implemented yet (M4)");
  }
}
