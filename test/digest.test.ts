import { describe, it, expect } from "vitest";
import { isOwnDigest, digestSubject, excludeOwnDigests } from "../src/domain/digest.js";
import type { EmailMessage } from "../src/domain/types.js";

function msg(subject: string): EmailMessage {
  return {
    id: subject,
    grantId: "g1",
    threadId: null,
    from: "x",
    fromEmail: "x@y.com",
    subject,
    snippet: "",
    receivedAt: 0,
    unread: false,
  };
}

describe("own-digest detection", () => {
  it("recognizes the app's own digest subjects", () => {
    expect(isOwnDigest(digestSubject("3 asks await reply"))).toBe(true);
    expect(isOwnDigest("Re: lunch tomorrow")).toBe(false);
  });

  it("filters the app's own digests out of a message list", () => {
    const kept = excludeOwnDigests([
      msg("Q3 budget"),
      msg(digestSubject("yesterday")),
      msg("Invoice #42"),
    ]);
    expect(kept.map((m) => m.subject)).toEqual(["Q3 budget", "Invoice #42"]);
  });
});
