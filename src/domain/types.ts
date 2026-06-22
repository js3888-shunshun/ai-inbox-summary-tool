/**
 * Provider-agnostic domain types. These deliberately do NOT mirror the Nylas
 * SDK shapes 1:1 — the Nylas adapter maps into these so the rest of the app
 * (storage, AI seam, scheduler) never imports a vendor type.
 */

/** A connected mailbox. One grant per connected account. */
export interface Grant {
  grantId: string;
  email: string;
  /** Where digests are sent (may differ from the connected mailbox). */
  destinationEmail: string;
  createdAt: number;
  /** When true, only the Gmail Primary tab is summarized (skip Updates/Promotions/Social/Forums). */
  primaryOnly: boolean;
}

/** The minimal slice of a message we need to summarize it. */
export interface EmailMessage {
  id: string;
  grantId: string;
  threadId: string | null;
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  /** Unix seconds, from the provider's `date` field. */
  receivedAt: number;
  unread: boolean;
  /** Provider folder/label ids (e.g. INBOX, SPAM, TRASH). Present on freshly
   *  fetched messages; omitted for rows read back from our own store. */
  folders?: string[];
}

/** Cadence configuration for a grant. Changing this needs no code change. */
export interface Schedule {
  grantId: string;
  /** e.g. "hourly", "every:3h", "daily:09:00". Parsed by the scheduler. */
  cadence: string;
  /** IANA timezone for daily cadences, e.g. "America/New_York". */
  timezone: string;
  enabled: boolean;
}
