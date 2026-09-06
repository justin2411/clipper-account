// Scout: liest neue Benachrichtigungs-Mails (Gmail), legt Kampagnen-Entwürfe an, meldet per Telegram,
// startet Clip-Jobs (GitHub Actions) für Kampagnen mit Status 'joined' + Footage-URL.
// Absender-Domain → Plattform-Adapter. Nach der ersten echten Vyro-Mail hier UND in platforms/vyro.py kalibrieren.
import { Env, db, logEvent, telegram, toCampaign } from "./shared";
import { runFan } from "./fan";

const SENDERS: Record<string, string> = { "vyro.com": "vyro", "whop.com": "whop" };
const NEW_CAMPAIGN = /new campaign|campaign.*(live|dropped|open)/;
const PAYOUT = /approved|earnings|payout|available/;

async function gmailToken(env: Env): Promise<string | null> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: "refresh_token" }),
  });
  const j: any = await r.json();
  if (!j.access_token) console.log("[scout] gmail token fehlgeschlagen", JSON.stringify(j).slice(0, 200));
  return j.access_token ?? null;
}

interface Mail { id: string; subject: string; from: string; body: string }

const b64url = (s: string) => { try { return atob(s.replace(/-/g, "+").replace(/_/g, "/")); } catch { return ""; } };

function textOf(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return b64url(payload.body.data);
  for (const p of payload.parts ?? []) { const t = textOf(p); if (t) return t; }
  if (payload.mimeType === "text/html" && payload.body?.data) return b64url(payload.body.data).replace(/<[^>]+>/g, " ");
  return payload.body?.data ? b64url(payload.body.data) : "";
}

async function newMails(env: Env, tok: string): Promise<Mail[]> {
  const H = { Authorization: `Bearer ${tok}` };
  const q = encodeURIComponent(`newer_than:2d (${Object.keys(SENDERS).map((d) => `from:${d}`).join(" OR ")})`);
  const list: any = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=50`, { headers: H })).json();
  const out: Mail[] = [];
  for (const m of list.messages ?? []) {
    const seen = await db.first(env, "SELECT id FROM events WHERE event = ? LIMIT 1", `mail:${m.id}`);
    if (seen) continue;
    const full: any = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: H })).json();
    const h = (n: string) => full.payload?.headers?.find((x: any) => x.name.toLowerCase() === n)?.value ?? "";
    out.push({ id: m.id, subject: h("subject"), from: h("from"), body: textOf(full.payload) });
  }
  return out;
}

export async function dispatchClipJob(env: Env, campaignId: string, account: string): Promise<number> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) { console.log("[scout] GITHUB_TOKEN/REPO fehlt – kein Dispatch"); return 0; }
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/clip.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "clipforge-worker", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs: { campaign: campaignId, account } }),
  });
  if (r.status !== 204) console.log("[scout] dispatch fehlgeschlagen", r.status, await r.text());
  return r.status;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export async function runScout(env: Env) {
  const stats = { mails: 0, campaigns: 0, payouts: 0, dispatched: 0, gmail: false, fan: null as any };
  const tok = await gmailToken(env);
  if (tok) {
    stats.gmail = true;
    for (const m of await newMails(env, tok)) {
      const platform = Object.entries(SENDERS).find(([d]) => m.from.toLowerCase().includes(d))?.[1];
      if (!platform) continue;
      stats.mails++;
      await logEvent(env, `mail:${m.id}`);
      const t = `${m.subject}\n${m.body}`.toLowerCase();
      const payout = t.match(/\$\s?([\d,]+\.?\d*)/);
      if (PAYOUT.test(t) && payout) {
        await db.run(env, "INSERT INTO payouts (amount_usd, source) VALUES (?, 'email')", Number(payout[1].replace(/,/g, "")));
        stats.payouts++;
        continue;
      }
      if (NEW_CAMPAIGN.test(t)) {
        const id = `${platform}-${slug(m.subject)}`;
        const url = m.body.match(/https?:\/\/(?:app\.)?vyro\.com\/campaigns\/[\w-]+/)?.[0] ?? "";
        await db.run(env, "INSERT OR IGNORE INTO campaigns (id, platform, name, external_url, status) VALUES (?, ?, ?, ?, 'draft')", id, platform, m.subject, url);
        stats.campaigns++;
        await telegram(env, `🆕 ${platform.toUpperCase()}: ${m.subject}\n${url}\n\n1) Join tippen  2) Footage-Link (Drive) setzen:\npython scripts/set_footage.py ${id} <url> config/campaign_template.yaml`);
      }
    }
  } else {
    console.log("[scout] Gmail nicht konfiguriert – nur Dispatch-Prüfung");
  }

  // Kampagnen mit Footage → Clip-Jobs starten (einmalig, dann 'active')
  const ready = (await db.all(env, "SELECT * FROM campaigns WHERE status = 'joined' AND kind = 'paid' AND COALESCE(json_extract(footage, '$.url'), '') != ''")).map(toCampaign);
  for (const c of ready) {
    let okAll = true;
    for (const a of c.accounts) {
      const st = await dispatchClipJob(env, c.id, a);
      if (st === 204) stats.dispatched++; else okAll = false;
    }
    if (okAll && c.accounts.length) {
      await db.run(env, "UPDATE campaigns SET status = 'active' WHERE id = ?", c.id);
      await logEvent(env, "clip_jobs_dispatched", c.id);
    }
  }
  // Fan-Content: YouTube-RSS (alle 30 min) + Backlog-Nachschub (Vorrat STOCK_DAYS Tage)
  try { stats.fan = await runFan(env); } catch (e: any) { stats.fan = { error: String(e?.message ?? e).slice(0, 120) }; await logEvent(env, `fan error ${String(e?.message ?? e).slice(0, 120)}`); }
  return stats;
}
