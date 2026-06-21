import type { EmailMessage } from "./types.js";

/**
 * The app sends digests as email, which — when the destination is the connected
 * mailbox itself — arrive back in the inbox. We tag them with a known subject
 * prefix so they are never ingested or summarized (otherwise the app would
 * summarize its own digests, producing "meta-digests").
 */
export const DIGEST_SUBJECT_PREFIX = "Inbox digest";

/** Older prefix still recognized so previously-sent digests are filtered too. */
const LEGACY_SUBJECT_PREFIXES = ["📥 Inbox digest"];

export function digestSubject(headline: string): string {
  return `${DIGEST_SUBJECT_PREFIX}: ${headline}`;
}

export function isOwnDigest(subject: string): boolean {
  return (
    subject.startsWith(DIGEST_SUBJECT_PREFIX) ||
    LEGACY_SUBJECT_PREFIXES.some((p) => subject.startsWith(p))
  );
}

export function excludeOwnDigests(messages: EmailMessage[]): EmailMessage[] {
  return messages.filter((m) => !isOwnDigest(m.subject));
}
