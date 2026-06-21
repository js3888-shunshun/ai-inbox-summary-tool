import type { EmailMessage } from "../domain/types.js";

/** Boundary #1 of the AI seam: deterministically assemble the model input. */
export interface CompletionInput {
  system: string;
  user: string;
}

const SYSTEM_PROMPT = `You are an assistant that writes a concise, genuinely useful digest of someone's email inbox.

You will be given a list of recent messages. Write a digest that helps the reader skip the firehose, focusing on what actually matters:
- the senders and threads that matter most
- explicit asks or questions awaiting a reply from the reader
- deadlines, dates, and time-sensitive items
- anything that looks important, urgent, or actionable

Do NOT just list subject lines. Group related items, be specific, and keep it skimmable.

Respond with ONLY a JSON object (no markdown fences, no prose around it) of the form:
{"headline": "<one-line summary, max ~80 chars>", "body": "<the digest as short markdown: a few bullet groups>"}`;

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
