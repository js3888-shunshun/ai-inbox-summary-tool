import { describe, it, expect, vi } from "vitest";
import type { EmailMessage } from "../src/domain/types.js";
import { buildSummaryPrompt } from "../src/ai/prompt.js";
import { parseDigest } from "../src/ai/parse.js";
import { ClaudeSummarizer, type CompletionFn } from "../src/ai/claude-summarizer.js";

function msg(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "m1",
    grantId: "g1",
    threadId: "t1",
    from: "Alice Example",
    fromEmail: "alice@example.com",
    subject: "Q3 budget review",
    snippet: "Can you send the numbers before Friday?",
    receivedAt: 1_750_000_000,
    unread: true,
    ...overrides,
  };
}

describe("buildSummaryPrompt", () => {
  it("includes sender, subject and snippet for each message", () => {
    const { system, user } = buildSummaryPrompt([msg()]);
    expect(system).toContain("digest");
    expect(user).toContain("Alice Example");
    expect(user).toContain("Q3 budget review");
    expect(user).toContain("before Friday");
  });

  it("does not leak read/unread status into the prompt", () => {
    const { system, user } = buildSummaryPrompt([msg({ unread: true })]);
    expect(user).not.toContain("UNREAD");
    expect(system.toLowerCase()).toContain("unread"); // only as an instruction not to mention it
  });

  it("is deterministic for the same input", () => {
    const a = buildSummaryPrompt([msg(), msg({ id: "m2" })]);
    const b = buildSummaryPrompt([msg(), msg({ id: "m2" })]);
    expect(a).toEqual(b);
  });
});

describe("parseDigest", () => {
  it("parses a clean JSON object into headline + sections", () => {
    const raw =
      '{"headline":"3 asks need replies","sections":[{"title":"Needs your reply","tone":"action","items":[{"from":"Alice","summary":"send the numbers"}]}]}';
    expect(parseDigest(raw, 3)).toEqual({
      headline: "3 asks need replies",
      messageCount: 3,
      sections: [
        { title: "Needs your reply", tone: "action", items: [{ from: "Alice", summary: "send the numbers" }] },
      ],
    });
  });

  it("tolerates fences, defaults tone to info, and a missing sender to empty", () => {
    const raw = 'Here you go:\n```json\n{"headline":"h","sections":[{"title":"FYI","items":[{"summary":"b"}]}]}\n```\nThanks!';
    expect(parseDigest(raw, 1)).toEqual({
      headline: "h",
      messageCount: 1,
      sections: [{ title: "FYI", tone: "info", items: [{ from: "", summary: "b" }] }],
    });
  });

  it("throws on non-JSON output", () => {
    expect(() => parseDigest("I could not summarize this.", 1)).toThrow();
  });

  it("throws when sections are missing or empty", () => {
    expect(() => parseDigest('{"headline":"h"}', 1)).toThrow();
    expect(() => parseDigest('{"headline":"h","sections":[]}', 1)).toThrow();
  });
});

describe("ClaudeSummarizer", () => {
  it("short-circuits empty inboxes without calling the model", async () => {
    const complete = vi.fn<CompletionFn>();
    const digest = await new ClaudeSummarizer(complete).summarize([]);
    expect(complete).not.toHaveBeenCalled();
    expect(digest.messageCount).toBe(0);
    expect(digest.sections).toEqual([]);
  });

  it("assembles input, calls the model, and parses the output", async () => {
    const complete: CompletionFn = vi.fn(async (input) => {
      expect(input.user).toContain("Q3 budget review");
      return '{"headline":"1 ask awaiting reply","sections":[{"title":"Needs your reply","tone":"action","items":[{"from":"Alice","summary":"send numbers by Friday"}]}]}';
    });
    const digest = await new ClaudeSummarizer(complete).summarize([msg()]);
    expect(digest).toEqual({
      headline: "1 ask awaiting reply",
      messageCount: 1,
      sections: [
        { title: "Needs your reply", tone: "action", items: [{ from: "Alice", summary: "send numbers by Friday" }] },
      ],
    });
  });
});
