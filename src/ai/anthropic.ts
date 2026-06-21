import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { CompletionFn } from "./claude-summarizer.js";

/**
 * Build a CompletionFn backed by the Anthropic (Claude) API. This is the only
 * file that knows about the LLM vendor SDK; the summarizer depends on the
 * CompletionFn type, so the model can be swapped or faked.
 */
export function anthropicCompletion(cfg: Config["llm"]): CompletionFn {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  return async ({ system, user }) => {
    const res = await client.messages.create({
      model: cfg.model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    });
    return res.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
  };
}
