import type { Digest, DigestSection, DigestTone } from "../ai/summarizer.js";

/**
 * Renders a Digest as a self-contained, inline-styled HTML block — used both as
 * the email body (mail clients strip <style>, so all styling is inline) and the
 * web preview. Sections are color-coded by tone so the eye lands on what matters.
 */

interface ToneStyle {
  accent: string;
  bg: string;
}

const TONE: Record<DigestTone, ToneStyle> = {
  urgent: { accent: "#dc2626", bg: "#fef2f2" },
  action: { accent: "#2563eb", bg: "#eff6ff" },
  info: { accent: "#6b7280", bg: "#f9fafb" },
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function renderItem(from: string, summary: string): string {
  const who = from
    ? `<span style="font-weight:600;color:#111827">${escapeHtml(from)}</span> `
    : "";
  return (
    `<li style="margin:0 0 8px;padding:0;line-height:1.5;color:#374151;font-size:14px">` +
    `${who}${escapeHtml(summary)}</li>`
  );
}

function renderSection(s: DigestSection): string {
  const t = TONE[s.tone] ?? TONE.info;
  const items = s.items.map((it) => renderItem(it.from, it.summary)).join("");
  return (
    `<div style="margin:0 0 16px;border:1px solid #eef0f3;border-left:4px solid ${t.accent};` +
    `border-radius:10px;background:${t.bg};padding:14px 16px">` +
    `<div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;` +
    `color:${t.accent};margin:0 0 10px">${escapeHtml(s.title)}</div>` +
    `<ul style="margin:0;padding:0 0 0 18px">${items}</ul>` +
    `</div>`
  );
}

export function renderDigestHtml(digest: Digest): string {
  const { headline, sections, messageCount } = digest;
  const body =
    sections.length === 0
      ? `<p style="color:#6b7280;font-size:14px;margin:0">Your inbox has been quiet. Nothing new to summarize.</p>`
      : sections.map(renderSection).join("");
  const count = `${messageCount} message${messageCount === 1 ? "" : "s"}`;
  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `max-width:640px;margin:0 auto;padding:24px;background:#ffffff;color:#1f2329">` +
    `<div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9ca3af">` +
    `Inbox digest</div>` +
    `<h1 style="font-size:20px;line-height:1.35;margin:6px 0 4px;color:#111827">${escapeHtml(headline)}</h1>` +
    `<div style="font-size:13px;color:#9ca3af;margin:0 0 20px">Covering ${count}</div>` +
    body +
    `<div style="border-top:1px solid #eef0f3;margin-top:8px;padding-top:14px;font-size:12px;color:#9ca3af">` +
    `Sent by AI Inbox Summary.</div>` +
    `</div>`
  );
}
