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

export function digestSubject(headline: string, messageCount?: number): string {
  const count =
    typeof messageCount === "number"
      ? ` (${messageCount} message${messageCount === 1 ? "" : "s"})`
      : "";
  return `${DIGEST_SUBJECT_PREFIX}${count}: ${headline}`;
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

/**
 * Gmail category labels we treat as low-signal and keep out of the digest, so the
 * Promotions and Social tabs (which `in:["INBOX"]` would otherwise include) don't
 * bury real Primary/Updates mail. Primary and Updates (USCIS, banks, job
 * applications) are kept.
 */
const NOISY_CATEGORIES = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"];

export function isNoisyCategory(m: EmailMessage): boolean {
  return m.folders?.some((f) => NOISY_CATEGORIES.includes(f)) ?? false;
}

export function excludeNoisyCategories(messages: EmailMessage[]): EmailMessage[] {
  return messages.filter((m) => !isNoisyCategory(m));
}
