import type { FastifyBaseLogger } from "fastify";
import type { DB } from "../db/index.js";
import type { MailProvider } from "../mail/provider.js";
import type { Summarizer } from "../ai/summarizer.js";
import type { Grant, Schedule } from "../domain/types.js";
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

function renderEmailBody(headline: string, body: string): string {
  return (
    `<div style="font-family:system-ui,sans-serif;max-width:640px">` +
    `<h2>📥 Inbox digest</h2><p><strong>${escapeHtml(headline)}</strong></p>` +
    `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(body)}</pre>` +
    `<hr><p style="color:#888;font-size:12px">Sent by AI Inbox Summary.</p></div>`
  );
}

/** Compose a digest from the given messages, send it, and mark them summarized. */
async function composeAndSend(deps: SchedulerDeps, grant: Grant): Promise<number> {
  const messages = listUnsummarized(deps.db, grant.grantId);
  const digest = await deps.summarizer.summarize(messages);
  await deps.mail.sendEmail(grant.grantId, {
    to: grant.destinationEmail,
    subject: `📥 Inbox digest — ${digest.headline}`,
    body: renderEmailBody(digest.headline, digest.body),
  });
  markSummarized(
    deps.db,
    messages.map((m) => m.id),
  );
  return digest.messageCount;
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
    const messages = listUnsummarized(deps.db, grant.grantId);
    if (messages.length === 0) {
      deps.log.info({ grantId: grant.grantId, windowKey }, "no new mail; window consumed");
      return "empty";
    }
    await composeAndSend(deps, grant);
    deps.log.info({ grantId: grant.grantId, windowKey, count: messages.length }, "digest sent");
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

/** Manual trigger (ignores cadence/idempotency) — used by the "send now" button. */
export async function sendDigestNow(deps: SchedulerDeps, grant: Grant): Promise<number> {
  return composeAndSend(deps, grant);
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
