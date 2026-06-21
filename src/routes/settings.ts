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
      return reply.code(400).send({ error: "no schedule to update, save one first" });
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

/** Numbers offered in the interval dropdown (the current value is injected if missing). */
const CADENCE_NUMBERS = [1, 2, 3, 5, 10, 15, 20, 30, 45] as const;

interface CadenceParts {
  mode: "every" | "daily";
  num: number;
  unit: "m" | "h";
  time: string; // HH:MM, used by the daily mode
}

/** Decompose a stored cadence string into the separate dropdown parts. */
function cadenceParts(current: string): CadenceParts {
  if (current.startsWith("daily:")) {
    return { mode: "daily", num: 1, unit: "h", time: current.slice("daily:".length) || "09:00" };
  }
  if (current === "hourly") return { mode: "every", num: 1, unit: "h", time: "09:00" };
  const m = /^every:(\d+)([mh])$/.exec(current);
  if (m) return { mode: "every", num: Number(m[1]), unit: m[2] as "m" | "h", time: "09:00" };
  return { mode: "every", num: 1, unit: "h", time: "09:00" }; // safe fallback
}

/** Render the interval-number <option> list, injecting the current value if off-preset. */
function numberOptions(selected: number): string {
  const known = (CADENCE_NUMBERS as readonly number[]).includes(selected);
  const nums = known ? [...CADENCE_NUMBERS] : [selected, ...CADENCE_NUMBERS].sort((a, b) => a - b);
  return nums
    .map((n) => `<option value="${n}"${n === selected ? " selected" : ""}>${n}</option>`)
    .join("");
}

/** Full IANA timezone list (falls back to a small set on older runtimes). */
function timezoneList(): string[] {
  const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof supported === "function") return supported("timeZone");
  return ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Shanghai", "Asia/Tokyo"];
}

function timezoneOptions(current: string): string {
  const zones = timezoneList();
  if (!zones.includes(current)) zones.unshift(current);
  return zones
    .map((z) => `<option value="${esc(z)}"${z === current ? " selected" : ""}>${esc(z)}</option>`)
    .join("");
}

function renderCard(g: { grantId: string; email: string; destinationEmail: string }, db: DB): string {
  const s = getSchedule(db, g.grantId);
  const cadence = s?.cadence ?? "hourly";
  const tz = s?.timezone ?? "UTC";
  const enabled = s?.enabled ?? false;
  const p = cadenceParts(cadence);
  const isDaily = p.mode === "daily";
  const pill = !s
    ? `<span class="pill none">No schedule</span>`
    : enabled
      ? `<span class="pill on">Active</span>`
      : `<span class="pill off">Paused</span>`;
  const toggle = s
    ? enabled
      ? `<button class="btn" onclick="setEnabled(this,false)">Pause</button>`
      : `<button class="btn" onclick="setEnabled(this,true)">Resume</button>`
    : "";
  const initial = esc((g.email.trim()[0] ?? "?").toUpperCase());
  return `
<article class="card">
  <header class="card-head">
    <div class="mailbox">
      <span class="avatar">${initial}</span>
      <div>
        <div class="email">${esc(g.email)}</div>
        <div class="sub">Sends to ${esc(g.destinationEmail)}</div>
      </div>
    </div>
    ${pill}
  </header>
  <input type="hidden" class="grantId" value="${esc(g.grantId)}">
  <div class="fields">
    <label class="field"><span>Cadence</span>
      <select class="cadMode" onchange="onCadence(this)">
        <option value="every"${isDaily ? "" : " selected"}>Every</option>
        <option value="daily"${isDaily ? " selected" : ""}>Daily at</option>
      </select>
    </label>
    <label class="field interval"${isDaily ? ` style="display:none"` : ""}><span>How often</span>
      <span class="interval-row">
        <select class="cadNum">${numberOptions(p.num)}</select>
        <select class="cadUnit">
          <option value="m"${p.unit === "m" ? " selected" : ""}>minutes</option>
          <option value="h"${p.unit === "h" ? " selected" : ""}>hours</option>
        </select>
      </span>
    </label>
    <label class="field daily-time"${isDaily ? "" : ` style="display:none"`}><span>At</span>
      <input type="time" class="dailyTime" value="${esc(p.time)}">
    </label>
    <label class="field"><span>Timezone</span>
      <select class="timezone">${timezoneOptions(tz)}</select>
    </label>
    <label class="field grow"><span>Send digests to</span>
      <input class="dest" type="email" value="${esc(g.destinationEmail)}" placeholder="name@example.com">
    </label>
  </div>
  <footer class="actions">
    <button class="btn primary" onclick="saveSchedule(this)">Save</button>
    ${toggle}
    <button class="btn" onclick="sendNow(this)">Send digest now</button>
    <span class="status"></span>
    <button class="btn danger" onclick="disconnect(this)">Disconnect</button>
  </footer>
</article>`;
}

function renderHome(db: DB): string {
  const grants = listGrants(db);
  const cards = grants.map((g) => renderCard(g, db)).join("");
  const empty = `
<div class="empty">
  <h2>No mailbox connected yet</h2>
  <p>Connect a mailbox to start receiving inbox summaries on a schedule you choose.</p>
  <a class="btn primary lg" href="/auth" onclick="return openConnect(event)">Connect a mailbox</a>
</div>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Inbox Summary</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <div>
      <h1>AI Inbox Summary</h1>
      <p class="tagline">One clear summary of your inbox, on a schedule you choose.</p>
    </div>
    <div class="hero-actions">
      <a class="btn ghost" href="/debug/digest">Preview</a>
      <a class="btn primary" href="/auth" onclick="return openConnect(event)">Connect a mailbox</a>
    </div>
  </header>

  ${grants.length
    ? `<div class="section-head"><h2>Connected mailboxes</h2><span class="count">${grants.length}</span></div>${cards}`
    : empty}

  <footer class="foot">
    Each mailbox gets its own cadence, destination, and on/off switch. Built on Nylas + Claude.
  </footer>
</div>
<script>
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}
// Open hosted auth in a new tab via script, so the callback can reload this page
// and close itself once the mailbox is connected. href is the no-JS fallback.
function openConnect(e) {
  if (e) e.preventDefault();
  window.open("/auth", "nylas_connect");
  return false;
}
function onCadence(sel) {
  const card = sel.closest(".card");
  const daily = sel.value === "daily";
  card.querySelector(".interval").style.display = daily ? "none" : "";
  card.querySelector(".daily-time").style.display = daily ? "" : "none";
}
function fields(btn) {
  const card = btn.closest(".card");
  const mode = card.querySelector(".cadMode").value;
  const cadence = mode === "daily"
    ? "daily:" + (card.querySelector(".dailyTime").value || "09:00")
    : "every:" + card.querySelector(".cadNum").value + card.querySelector(".cadUnit").value;
  return {
    el: card.querySelector(".status"),
    grantId: card.querySelector(".grantId").value,
    cadence,
    timezone: card.querySelector(".timezone").value,
    destinationEmail: card.querySelector(".dest").value,
  };
}
function flash(el, msg, kind) { el.textContent = msg; el.className = "status " + (kind || ""); }
async function saveSchedule(btn) {
  const f = fields(btn); flash(f.el, "Saving");
  const { ok, data } = await post("/schedule", f);
  flash(f.el, ok ? "Saved" : (data.error || "error"), ok ? "ok" : "err");
}
async function sendNow(btn) {
  const f = fields(btn); flash(f.el, "Sending");
  const { ok, data } = await post("/send-now", { grantId: f.grantId });
  flash(f.el, ok ? "Sent (" + data.messageCount + " msgs)" : (data.error || "error"), ok ? "ok" : "err");
}
async function setEnabled(btn, enabled) {
  const f = fields(btn); flash(f.el, enabled ? "Resuming" : "Pausing");
  const { ok, data } = await post("/schedule/enabled", { grantId: f.grantId, enabled });
  if (ok) location.reload(); else flash(f.el, (data.error || "error"), "err");
}
async function disconnect(btn) {
  const f = fields(btn);
  if (!confirm("Disconnect this mailbox? This revokes the grant and deletes its local data.")) return;
  flash(f.el, "Disconnecting");
  const { ok, data } = await post("/disconnect", { grantId: f.grantId });
  if (ok) location.reload(); else flash(f.el, (data.error || "error"), "err");
}
</script>
</body></html>`;
}

const STYLE = `
:root{
  --bg:#f5f6f8; --card:#fff; --ink:#1f2329; --muted:#6b7280; --line:#e5e7eb;
  --brand:#1a73e8; --brand-d:#1557b0; --green:#16a34a; --amber:#d97706; --red:#dc2626;
  --shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.1);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
.wrap{max-width:780px;margin:0 auto;padding:32px 20px 64px}
.hero{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:28px}
.hero h1{margin:0;font-size:26px;letter-spacing:-.02em}
.tagline{margin:6px 0 0;color:var(--muted);font-size:14px}
.hero-actions{display:flex;gap:10px}
.section-head{display:flex;align-items:center;gap:10px;margin:0 0 14px}
.section-head h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0}
.count{background:#eef2ff;color:var(--brand-d);font-size:12px;font-weight:600;
  padding:2px 9px;border-radius:999px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  box-shadow:var(--shadow);padding:18px 20px;margin-bottom:16px}
.card-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}
.mailbox{display:flex;align-items:center;gap:12px;min-width:0}
.avatar{flex:none;width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#1a73e8,#6aa9ff);
  color:#fff;font-weight:600;display:grid;place-items:center;font-size:16px}
.email{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{flex:none;font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px}
.pill.on{background:#e7f6ec;color:var(--green)}
.pill.off{background:#fef3e2;color:var(--amber)}
.pill.none{background:#f1f3f5;color:var(--muted)}
.fields{display:flex;flex-wrap:wrap;gap:12px 14px;margin-bottom:16px}
.field{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted)}
.field.grow{flex:1 1 220px}
.field span{font-weight:600;letter-spacing:.01em}
.field select,.field input{font:inherit;font-size:14px;color:var(--ink);background:#fff;
  border:1px solid var(--line);border-radius:9px;padding:8px 10px;min-width:0;width:100%}
.field select:focus,.field input:focus{outline:none;border-color:var(--brand);
  box-shadow:0 0 0 3px rgba(26,115,232,.15)}
.daily-time{flex:none}
.daily-time input{width:120px}
.interval{flex:none}
.interval-row{display:flex;gap:8px}
.interval-row select{width:auto}
.cadNum{min-width:62px}
.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:14px}
.btn{font:inherit;font-size:13.5px;font-weight:500;cursor:pointer;border:1px solid var(--line);
  background:#fff;color:var(--ink);padding:8px 14px;border-radius:9px;text-decoration:none;
  display:inline-block;transition:background .12s,border-color .12s,box-shadow .12s}
.btn:hover{background:#f3f4f6}
.btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}
.btn.primary:hover{background:var(--brand-d);border-color:var(--brand-d)}
.btn.ghost{background:transparent;border-color:transparent;color:var(--brand-d)}
.btn.ghost:hover{background:#eef2ff}
.btn.danger{color:var(--red);border-color:transparent}
.btn.danger:hover{background:#fdecec}
.btn.lg{font-size:15px;padding:11px 20px}
.actions .danger{margin-left:auto}
.status{font-size:13px;color:var(--muted);min-height:1em}
.status.ok{color:var(--green)} .status.err{color:var(--red)}
.empty{background:var(--card);border:1px solid var(--line);border-radius:16px;
  box-shadow:var(--shadow);text-align:center;padding:56px 24px}
.empty h2{margin:0 0 6px;font-size:19px}
.empty p{color:var(--muted);margin:0 auto 22px;max-width:360px}
.foot{color:var(--muted);font-size:12.5px;text-align:center;margin-top:28px}
@media(max-width:520px){.actions .danger{margin-left:0}}
`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
