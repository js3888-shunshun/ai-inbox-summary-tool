import type { FastifyBaseLogger } from "fastify";
import type { DB } from "../db/index.js";
import type { MailProvider } from "../mail/provider.js";
import type { Digest, Summarizer } from "../ai/summarizer.js";
import type { EmailMessage, Grant, Schedule } from "../domain/types.js";
import { digestSubject, excludeOwnDigests } from "../domain/digest.js";
import { renderDigestHtml } from "../email/render.js";
import { getGrant } from "../store/grants.js";
import { listUnsummarized, markSummarized } from "../store/messages.js";
import { listEnabledSchedules } from "../store/schedules.js";
import { claimWindow, releaseWindow } from "../store/sent-windows.js";
import { parseCadence, windowKeyAt } from "./cadence.js";

export interface SchedulerDeps {
  db: DB;
  mail: MailProvider;
  summarizer: Summarizer;
  log: FastifyBaseLogger;
}

export type DigestOutcome = "sent" | "empty" | "skipped" | "error";

/** Summarize the given messages and email the digest to the grant's destination. */
async function composeAndSend(deps: SchedulerDeps, grant: Grant, messages: EmailMessage[]): Promise<Digest> {
  const digest = await deps.summarizer.summarize(messages);
  await deps.mail.sendEmail(grant.grantId, {
    to: grant.destinationEmail,
    subject: digestSubject(digest.headline),
    body: renderDigestHtml(digest),
  });
  return digest;
}

/**
 * Run the digest for one grant's due window. Claims the window first so a
 * concurrent run / restart / second instance cannot also send (exactly-once).
 * On send failure the claim is released so a later tick retries.
 */
export async function runScheduledDigest(
  deps: SchedulerDeps,
  grant: Grant,
  schedule: Schedule,
  nowMs: number,
): Promise<DigestOutcome> {
  const cadence = parseCadence(schedule.cadence);
  const windowKey = windowKeyAt(schedule.cadence, cadence, nowMs, schedule.timezone);

  if (!claimWindow(deps.db, grant.grantId, windowKey, nowMs)) {
    return "skipped"; // window already handled
  }
  try {
    // "Since last digest": mail accumulated by the webhook, minus our own digests.
    const accumulated = excludeOwnDigests(listUnsummarized(deps.db, grant.grantId));
    if (accumulated.length === 0) {
      deps.log.info({ grantId: grant.grantId, windowKey }, "no new mail; window consumed");
      return "empty";
    }
    // Validate against the live inbox so mail deleted or moved (to spam/trash)
    // since it arrived is excluded — the digest reflects the current inbox.
    const liveIds = new Set(
      (await deps.mail.listMessages(grant.grantId, { limit: 100 })).map((m) => m.id),
    );
    const inInbox = accumulated.filter((m) => liveIds.has(m.id));
    const consumedIds = accumulated.map((m) => m.id); // advance the watermark for all

    if (inInbox.length === 0) {
      markSummarized(deps.db, consumedIds);
      deps.log.info({ grantId: grant.grantId, windowKey }, "accumulated mail no longer in inbox; skipped");
      return "empty";
    }
    await composeAndSend(deps, grant, inInbox);
    markSummarized(deps.db, consumedIds);
    deps.log.info({ grantId: grant.grantId, windowKey, count: inInbox.length }, "digest sent");
    return "sent";
  } catch (err) {
    releaseWindow(deps.db, grant.grantId, windowKey); // allow retry next tick
    deps.log.error({ err, grantId: grant.grantId, windowKey }, "digest send failed");
    return "error";
  }
}

/** One scheduler pass over all enabled, per-grant schedules. */
export async function runSchedulerTick(deps: SchedulerDeps, nowMs: number = Date.now()): Promise<void> {
  for (const schedule of listEnabledSchedules(deps.db)) {
    const grant = getGrant(deps.db, schedule.grantId);
    if (!grant) continue;
    await runScheduledDigest(deps, grant, schedule, nowMs);
  }
}

/**
 * Manual trigger — summarizes a snapshot of the recent inbox (like the preview),
 * so it is always meaningful regardless of accumulation state. Does not touch the
 * since-last accounting used by the scheduled path.
 */
export async function sendDigestNow(deps: SchedulerDeps, grant: Grant, limit = 30): Promise<number> {
  const messages = excludeOwnDigests(await deps.mail.listMessages(grant.grantId, { limit }));
  const digest = await composeAndSend(deps, grant, messages);
  return digest.messageCount;
}

/** Start the polling loop. Returns a stop function. */
export function startScheduler(deps: SchedulerDeps, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    void runSchedulerTick(deps).catch((err) => deps.log.error({ err }, "scheduler tick failed"));
  }, intervalMs);
  timer.unref?.();
  deps.log.info({ intervalMs }, "scheduler started");
  return () => clearInterval(timer);
}
