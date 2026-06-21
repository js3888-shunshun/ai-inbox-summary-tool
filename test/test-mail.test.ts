import { describe, it, expect, vi } from "vitest";
import type { MailProvider } from "../src/mail/provider.js";
import { sendTestEmails, MAX_TEST_EMAILS } from "../src/email/test-mail.js";

function fakeMail(): { mail: MailProvider; sendEmail: ReturnType<typeof vi.fn> } {
  const sendEmail = vi.fn(async () => {});
  const mail = { sendEmail } as unknown as MailProvider;
  return { mail, sendEmail };
}

describe("sendTestEmails", () => {
  it("sends `count` emails to the grant's own address", async () => {
    const { mail, sendEmail } = fakeMail();
    const sent = await sendTestEmails(mail, "g1", "me@example.com", 3);
    expect(sent).toHaveLength(3);
    expect(sendEmail).toHaveBeenCalledTimes(3);
    for (const call of sendEmail.mock.calls) {
      expect(call[0]).toBe("g1");
      expect(call[1].to).toBe("me@example.com");
      expect(typeof call[1].subject).toBe("string");
    }
  });

  it("clamps count to at least 1 and at most the max", async () => {
    const { mail, sendEmail } = fakeMail();
    await sendTestEmails(mail, "g1", "me@example.com", 0);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    sendEmail.mockClear();
    await sendTestEmails(mail, "g1", "me@example.com", 999);
    expect(sendEmail).toHaveBeenCalledTimes(MAX_TEST_EMAILS);
  });

  it("disambiguates subjects when cycling past the template set", async () => {
    const { mail } = fakeMail();
    const sent = await sendTestEmails(mail, "g1", "me@example.com", 8);
    expect(new Set(sent).size).toBe(8); // all distinct
  });
});
