import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import type { MailProvider } from "../mail/provider.js";
import type { Summarizer } from "../ai/summarizer.js";
import { deleteGrantCascade, getGrant, listGrants, setDestinationEmail } from "../store/grants.js";
import { getSchedule, saveSchedule, setScheduleEnabled } from "../store/schedules.js";
import { isValidCadence } from "../scheduler/cadence.js";
import { sendDigestNow } from "../scheduler/scheduler.js";

interface SettingsDeps {
  db: DB;
  mail: MailProvider;
  summarizer: Summarizer;
}

interface ScheduleBody {
  grantId?: string;
  cadence?: string;
  timezone?: string;
  destinationEmail?: string;
}

/**
 * Minimal home/settings UI plus its JSON API:
 *   GET  /          status page: connect a mailbox, set cadence + destination, send now
 *   POST /schedule  upsert a grant's cadence/timezone/destination (no code change needed)
 *   POST /send-now  manually trigger a digest for a grant
 */
export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsDeps): void {
  const { db } = deps;

  app.get("/", async (_req, reply) => {
    return reply.type("text/html").send(renderHome(db));
  });

  app.post("/schedule", async (req, reply) => {
    const b = req.body as ScheduleBody;
    if (!b.grantId || !getGrant(db, b.grantId)) {
      return reply.code(400).send({ error: "unknown grantId" });
    }
    if (!b.cadence || !isValidCadence(b.cadence)) {
      return reply.code(400).send({ error: "invalid cadence (try hourly, every:5m, every:2h, daily:09:00)" });
    }
    saveSchedule(db, {
      grantId: b.grantId,
      cadence: b.cadence,
      timezone: b.timezone?.trim() || "UTC",
      enabled: true,
    });
    if (b.destinationEmail?.trim()) {
      setDestinationEmail(db, b.grantId, b.destinationEmail.trim());
    }
    return reply.send({ ok: true });
  });

  app.post("/send-now", async (req, reply) => {
    const b = req.body as ScheduleBody;
    const grant = b.grantId ? getGrant(db, b.grantId) : undefined;
    if (!grant) return reply.code(400).send({ error: "unknown grantId" });
    const messageCount = await sendDigestNow({ ...deps, log: app.log }, grant);
    return reply.send({ ok: true, messageCount });
  });

  // Pause / resume digests for a mailbox without losing its cadence.
  app.post("/schedule/enabled", async (req, reply) => {
    const b = req.body as { grantId?: string; enabled?: boolean };
    if (!b.grantId || !getGrant(db, b.grantId)) {
      return reply.code(400).send({ error: "unknown grantId" });
    }
    if (!setScheduleEnabled(db, b.grantId, b.enabled === true)) {
      return reply.code(400).send({ error: "no schedule to update — save one first" });
    }
    return reply.send({ ok: true, enabled: b.enabled === true });
  });

  // Disconnect a mailbox: revoke the grant on Nylas, then drop all local data.
  app.post("/disconnect", async (req, reply) => {
    const b = req.body as { grantId?: string };
    if (!b.grantId || !getGrant(db, b.grantId)) {
      return reply.code(400).send({ error: "unknown grantId" });
    }
    try {
      await deps.mail.revokeGrant(b.grantId);
    } catch (err) {
      app.log.warn({ err, grantId: b.grantId }, "grant revoke failed; removing locally anyway");
    }
    deleteGrantCascade(db, b.grantId);
    return reply.send({ ok: true });
  });
}

function renderHome(db: DB): string {
  const grants = listGrants(db);
  const rows = grants
    .map((g) => {
      const s = getSchedule(db, g.grantId);
      const cadence = s?.cadence ?? "every:5m";
      const tz = s?.timezone ?? "UTC";
      const enabled = s?.enabled ?? false;
      const state = s ? (enabled ? "🟢 Active" : "⏸️ Paused") : "no schedule yet";
      const toggle = s
        ? enabled
          ? `<button onclick="setEnabled(this,false)">Pause</button>`
          : `<button onclick="setEnabled(this,true)">Resume</button>`
        : "";
      return `
<fieldset style="margin:12px 0">
  <legend><strong>${esc(g.email)}</strong> · ${s ? `<code>${esc(s.cadence)}</code> (${esc(s.timezone)}) — ` : ""}${state}</legend>
  <input type="hidden" class="grantId" value="${esc(g.grantId)}">
  <label>Cadence <input class="cadence" value="${esc(cadence)}" size="14"></label>
  <label>Timezone <input class="timezone" value="${esc(tz)}" size="18"></label>
  <label>Send digests to <input class="dest" value="${esc(g.destinationEmail)}" size="26"></label>
  <div style="margin-top:8px">
    <button onclick="saveSchedule(this)">Save schedule</button>
    ${toggle}
    <button onclick="sendNow(this)">Send digest now</button>
    <button onclick="disconnect(this)" style="color:#b00">Disconnect</button>
    <span class="status"></span>
  </div>
</fieldset>`;
    })
    .join("");

  return `<!doctype html><meta charset="utf-8"><title>AI Inbox Summary</title>
<body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px">
<h1>AI Inbox Summary</h1>
<p>
  <a href="/auth" style="display:inline-block;padding:8px 14px;background:#1a73e8;color:#fff;border-radius:6px;text-decoration:none">➕ Connect a mailbox</a>
  &nbsp; <a href="/debug/digest">🔎 Preview a digest</a>
</p>
<p style="color:#666;font-size:13px">Connect as many mailboxes as you like — each gets its own cadence, destination, and on/off switch.</p>
${grants.length ? `<h3>Connected mailboxes (${grants.length})</h3>${rows}` : "<p>No mailbox connected yet — click <b>Connect a mailbox</b>.</p>"}
<p style="color:#888;font-size:13px">Cadence examples: <code>hourly</code>, <code>every:5m</code>, <code>every:2h</code>, <code>daily:09:00</code>.</p>
<script>
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}
function fields(btn) {
  const fs = btn.closest("fieldset");
  return {
    el: fs.querySelector(".status"),
    grantId: fs.querySelector(".grantId").value,
    cadence: fs.querySelector(".cadence").value,
    timezone: fs.querySelector(".timezone").value,
    destinationEmail: fs.querySelector(".dest").value,
  };
}
async function saveSchedule(btn) {
  const f = fields(btn); f.el.textContent = "saving…";
  const { ok, data } = await post("/schedule", f);
  f.el.textContent = ok ? "✅ saved" : "❌ " + (data.error || "error");
}
async function sendNow(btn) {
  const f = fields(btn); f.el.textContent = "sending…";
  const { ok, data } = await post("/send-now", { grantId: f.grantId });
  f.el.textContent = ok ? "✅ sent (" + data.messageCount + " msgs)" : "❌ " + (data.error || "error");
}
async function setEnabled(btn, enabled) {
  const f = fields(btn); f.el.textContent = enabled ? "resuming…" : "pausing…";
  const { ok, data } = await post("/schedule/enabled", { grantId: f.grantId, enabled });
  if (ok) location.reload(); else f.el.textContent = "❌ " + (data.error || "error");
}
async function disconnect(btn) {
  const f = fields(btn);
  if (!confirm("Disconnect this mailbox? This revokes the grant and deletes its local data.")) return;
  f.el.textContent = "disconnecting…";
  const { ok, data } = await post("/disconnect", { grantId: f.grantId });
  if (ok) location.reload(); else f.el.textContent = "❌ " + (data.error || "error");
}
</script>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
