import { describe, it, expect } from "vitest";
import {
  isOwnDigest,
  digestSubject,
  excludeOwnDigests,
  excludeNoisyCategories,
} from "../src/domain/digest.js";
import type { EmailMessage } from "../src/domain/types.js";

function msg(subject: string, folders?: string[]): EmailMessage {
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
    ...(folders ? { folders } : {}),
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

describe("Gmail category filtering", () => {
  it("drops Promotions and Social, keeps Primary and Updates", () => {
    const kept = excludeNoisyCategories([
      msg("Wayne Yang interview", []), // Primary (no category)
      msg("USCIS case update", ["INBOX", "CATEGORY_UPDATES"]),
      msg("Devpost hackathons", ["INBOX", "CATEGORY_PROMOTIONS"]),
      msg("LinkedIn invite", ["INBOX", "CATEGORY_SOCIAL"]),
    ]);
    expect(kept.map((m) => m.subject)).toEqual(["Wayne Yang interview", "USCIS case update"]);
  });

  it("keeps messages with no folder info", () => {
    expect(excludeNoisyCategories([msg("no folders")]).map((m) => m.subject)).toEqual(["no folders"]);
  });
});
