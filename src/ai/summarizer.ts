import type { EmailMessage } from "../domain/types.js";

/**
 * The AI seam. Three explicit boundaries keep it testable and deterministic:
 *   1. assemble input   -> buildPrompt(messages)
 *   2. call the model   -> Summarizer.summarize(...)  (the only nondeterministic part)
 *   3. parse the output -> parseDigest(rawModelText)
 * Scheduler/transport code never touches model details; tests use a fake Summarizer.
 */
export interface Digest {
  /** One-line overview suitable for an email subject/preview. */
  headline: string;
  /** Markdown/plaintext body: who matters, asks awaiting reply, deadlines. */
  body: string;
  /** Number of messages this digest covers. */
  messageCount: number;
}

export interface Summarizer {
  summarize(messages: EmailMessage[]): Promise<Digest>;
}
