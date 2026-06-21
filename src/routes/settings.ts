import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import type { MailProvider } from "../mail/provider.js";
import type { Summarizer } from "../ai/summarizer.js";
import { getGrant, listGrants, setDestinationEmail } from "../store/grants.js";
import { getSchedule, saveSchedule } from "../store/schedules.js";
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
}

function renderHome(db: DB): string {
  const grants = listGrants(db);
  const rows = grants
    .map((g) => {
      const s = getSchedule(db, g.grantId);
      const cadence = s?.cadence ?? "every:5m";
      const tz = s?.timezone ?? "UTC";
      return `
<fieldset style="margin:12px 0">
  <legend><strong>${esc(g.email)}</strong> ${s ? `· current: <code>${esc(s.cadence)}</code> (${esc(s.timezone)})` : "· no schedule yet"}</legend>
  <input type="hidden" class="grantId" value="${esc(g.grantId)}">
  <label>Cadence <input class="cadence" value="${esc(cadence)}" size="14"></label>
  <label>Timezone <input class="timezone" value="${esc(tz)}" size="18"></label>
  <label>Send digests to <input class="dest" value="${esc(g.destinationEmail)}" size="26"></label>
  <button onclick="saveSchedule(this)">Save schedule</button>
  <button onclick="sendNow(this)">Send digest now</button>
  <span class="status"></span>
</fieldset>`;
    })
    .join("");

  return `<!doctype html><meta charset="utf-8"><title>AI Inbox Summary</title>
<body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px">
<h1>AI Inbox Summary</h1>
<p><a href="/auth">➕ Connect a mailbox</a> &nbsp;·&nbsp; <a href="/debug/digest">🔎 Preview a digest</a></p>
${grants.length ? rows : "<p>No mailbox connected yet — click <b>Connect a mailbox</b>.</p>"}
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
</script>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
