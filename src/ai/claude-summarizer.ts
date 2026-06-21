import type { EmailMessage } from "../domain/types.js";
import type { Digest, Summarizer } from "./summarizer.js";
import type { CompletionInput } from "./prompt.js";
import { buildSummaryPrompt } from "./prompt.js";
import { parseDigest } from "./parse.js";

/**
 * Boundary #2 of the AI seam: the actual model call, injected as a function so
 * the summarizer can be unit-tested with a fake completion (no network, no key).
 */
export type CompletionFn = (input: CompletionInput) => Promise<string>;

export class ClaudeSummarizer implements Summarizer {
  constructor(private readonly complete: CompletionFn) {}

  async summarize(messages: EmailMessage[]): Promise<Digest> {
    if (messages.length === 0) {
      return {
        headline: "No new mail since your last digest",
        body: "Your inbox has been quiet — nothing new to summarize.",
        messageCount: 0,
      };
    }
    const raw = await this.complete(buildSummaryPrompt(messages));
    return parseDigest(raw, messages.length);
  }
}
