import { describe, it, expect, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { openDb, type DB } from "../src/db/index.js";
import { saveGrant, getGrant } from "../src/store/grants.js";
import { saveSchedule, getSchedule } from "../src/store/schedules.js";
import { upsertMessage } from "../src/store/messages.js";
import { runScheduledDigest, type SchedulerDeps } from "../src/scheduler/scheduler.js";
import {
  parseCadence,
  isValidCadence,
  windowStartAt,
  windowKeyAt,
} from "../src/scheduler/cadence.js";
import type { MailProvider } from "../src/mail/provider.js";
import type { Summarizer } from "../src/ai/summarizer.js";
import type { EmailMessage } from "../src/domain/types.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

describe("parseCadence", () => {
  it("parses interval and daily forms", () => {
    expect(parseCadence("hourly")).toEqual({ kind: "interval", ms: 3_600_000 });
    expect(parseCadence("every:5m")).toEqual({ kind: "interval", ms: 300_000 });
    expect(parseCadence("every:2h")).toEqual({ kind: "interval", ms: 7_200_000 });
    expect(parseCadence("daily:09:30")).toEqual({ kind: "daily", hour: 9, minute: 30 });
  });
  it("rejects nonsense", () => {
    expect(isValidCadence("garbage")).toBe(false);
    expect(isValidCadence("every:0m")).toBe(false);
    expect(isValidCadence("daily:99:99")).toBe(false);
  });
});

describe("window alignment", () => {
  const c = parseCadence("every:5m");
  it("floors to the interval boundary", () => {
    const now = Date.UTC(2026, 5, 20, 10, 7, 30);
    expect(windowStartAt(c, now)).toBe(Date.UTC(2026, 5, 20, 10, 5, 0));
  });
  it("gives a stable key within a window and a new key across boundaries", () => {
    const a = windowKeyAt("every:5m", c, Date.UTC(2026, 5, 20, 10, 7, 30));
    const b = windowKeyAt("every:5m", c, Date.UTC(2026, 5, 20, 10, 9, 59));
    const next = windowKeyAt("every:5m", c, Date.UTC(2026, 5, 20, 10, 10, 0));
    expect(a).toBe(b);
    expect(a).not.toBe(next);
  });
});

function baseMsg(id: string): EmailMessage {
  return {
    id,
    grantId: "g1",
    threadId: null,
    from: "Alice",
    fromEmail: "a@x.com",
    subject: "Hi " + id,
    snippet: "hello",
    receivedAt: 1_750_000_000,
    unread: true,
  };
}

function seed(db: DB): void {
  saveGrant(db, {
    grantId: "g1",
    email: "u@example.com",
    destinationEmail: "dest@example.com",
    createdAt: Date.now(),
  });
  saveSchedule(db, { grantId: "g1", cadence: "every:5m", timezone: "UTC", enabled: true });
  upsertMessage(db, baseMsg("m1"));
  upsertMessage(db, baseMsg("m2"));
}

/** `liveInbox` is what the provider reports as currently in the inbox. */
function fakeDeps(
  db: DB,
  liveInbox: EmailMessage[] = [baseMsg("m1"), baseMsg("m2")],
): { deps: SchedulerDeps; sendEmail: ReturnType<typeof vi.fn> } {
  const sendEmail = vi.fn(async () => {});
  const mail = {
    authUrl: () => "",
    exchangeCode: async () => ({ grantId: "g1", email: "u@example.com" }),
    listMessages: async () => liveInbox,
    getMessage: async () => ({}) as EmailMessage,
    sendEmail,
    revokeGrant: async () => {},
  } as unknown as MailProvider;
  const summarizer: Summarizer = {
    summarize: async (msgs) => ({ headline: "h", body: "b", messageCount: msgs.length }),
  };
  return { deps: { db, mail, summarizer, log: silentLog }, sendEmail };
}

describe("runScheduledDigest exactly-once", () => {
  it("sends once per window, even when run twice", async () => {
    const db = openDb(":memory:");
    seed(db);
    const { deps, sendEmail } = fakeDeps(db);
    const grant = getGrant(db, "g1")!;
    const schedule = getSchedule(db, "g1")!;
    const now = Date.UTC(2026, 5, 20, 10, 5, 0);

    expect(await runScheduledDigest(deps, grant, schedule, now)).toBe("sent");
    expect(await runScheduledDigest(deps, grant, schedule, now)).toBe("skipped");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("treats a window with no new mail as empty (no send)", async () => {
    const db = openDb(":memory:");
    seed(db);
    const { deps, sendEmail } = fakeDeps(db);
    const grant = getGrant(db, "g1")!;
    const schedule = getSchedule(db, "g1")!;

    // first window consumes the two messages
    await runScheduledDigest(deps, grant, schedule, Date.UTC(2026, 5, 20, 10, 5, 0));
    // next window: nothing new
    const outcome = await runScheduledDigest(deps, grant, schedule, Date.UTC(2026, 5, 20, 10, 10, 0));
    expect(outcome).toBe("empty");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("excludes accumulated mail no longer in the inbox (deleted/moved)", async () => {
    const db = openDb(":memory:");
    seed(db); // m1, m2 accumulated
    // live inbox now only has m1 (m2 was deleted/moved after arrival)
    const { deps, sendEmail } = fakeDeps(db, [baseMsg("m1")]);
    const grant = getGrant(db, "g1")!;
    const schedule = getSchedule(db, "g1")!;

    const outcome = await runScheduledDigest(deps, grant, schedule, Date.UTC(2026, 5, 20, 10, 5, 0));
    expect(outcome).toBe("sent");
    // only the still-present message is summarized…
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // …and both are consumed, so the deleted one won't resurface next window
    const remaining = await runScheduledDigest(deps, grant, schedule, Date.UTC(2026, 5, 20, 10, 10, 0));
    expect(remaining).toBe("empty");
  });
});
