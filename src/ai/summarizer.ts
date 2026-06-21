import type { EmailMessage } from "../domain/types.js";

/**
 * The AI seam. Three explicit boundaries keep it testable and deterministic:
 *   1. assemble input   -> buildPrompt(messages)
 *   2. call the model   -> Summarizer.summarize(...)  (the only nondeterministic part)
 *   3. parse the output -> parseDigest(rawModelText)
 * Scheduler/transport code never touches model details; tests use a fake Summarizer.
 */
/** Accent/grouping for a section, most to least pressing. */
export type DigestTone = "urgent" | "action" | "info";

export interface DigestItem {
  /** Sender name (or a short label) this point came from. May be empty. */
  from: string;
  /** One specific, one-line summary of what matters. */
  summary: string;
}

export interface DigestSection {
  /** Short section label, e.g. "Needs your reply". */
  title: string;
  /** Drives the section's accent color when rendered. */
  tone: DigestTone;
  items: DigestItem[];
}

export interface Digest {
  /** One-line overview suitable for an email subject/preview. */
  headline: string;
  /** Grouped, scannable sections (urgent / needs action / fyi). */
  sections: DigestSection[];
  /** Number of messages this digest covers. */
  messageCount: number;
}

export interface Summarizer {
  summarize(messages: EmailMessage[]): Promise<Digest>;
}
