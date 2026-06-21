import type { EmailMessage } from "../domain/types.js";

/** Boundary #1 of the AI seam: deterministically assemble the model input. */
export interface CompletionInput {
  system: string;
  user: string;
}

const SYSTEM_PROMPT = `You are an assistant that writes a concise, genuinely useful digest of someone's email inbox.

You will be given a list of recent messages. Help the reader skip the firehose: surface what needs attention and group the rest.

Organize the digest into a few sections, ordered most important first. Give each section a "tone":
- "urgent": time-sensitive or high-stakes (deadlines, problems, anything that cannot wait)
- "action": needs a reply or an action from the reader, but is not an emergency
- "info": worth knowing only (FYI, newsletters, receipts); no action needed

Within a section, each item names the sender and states the single most useful point in one short line. Be specific (names, asks, dates). Do not just repeat subject lines. Omit empty sections; create only the sections that apply.

Write plain, neutral text. Do NOT use emoji, arrows, em-dashes, or markdown formatting inside any value.

Respond with ONLY a JSON object (no markdown fences, no prose around it) of the form:
{"headline":"<one-line overview, max ~80 chars>","sections":[{"title":"<short label>","tone":"urgent|action|info","items":[{"from":"<sender name>","summary":"<one specific line>"}]}]}`;

/** Render one message as a compact, deterministic block for the model. */
function formatMessage(m: EmailMessage, index: number): string {
  const when = new Date(m.receivedAt * 1000).toISOString().replace("T", " ").slice(0, 16);
  const flags = m.unread ? " [UNREAD]" : "";
  const snippet = m.snippet.replace(/\s+/g, " ").trim().slice(0, 280);
  return [
    `[${index + 1}] From: ${m.from} <${m.fromEmail}> | ${when} UTC${flags}`,
    `Subject: ${m.subject}`,
    `Snippet: ${snippet}`,
  ].join("\n");
}

/**
 * Build the prompt from collected messages. Pure and deterministic so it can be
 * unit-tested without calling a model.
 */
export function buildSummaryPrompt(messages: EmailMessage[]): CompletionInput {
  const body = messages.map(formatMessage).join("\n\n");
  const user = `Here are ${messages.length} recent inbox messages, newest first:\n\n${body}\n\nWrite the digest now.`;
  return { system: SYSTEM_PROMPT, user };
}
