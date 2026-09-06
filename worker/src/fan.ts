// Fan-Content (Dauerbetrieb) – Footage kommt ausschließlich per Upload über die Nischen-Seite des Dashboards (R2).
//   • Upload fertig → Fan-Kampagne "fan-<uploadId>" der Nische (kind='fan') → EIN Clip-Job für alle Accounts der Nische
//     (Account "AB": Momente Rang 1,3,5… → A, 2,4,6… → B).
//   • YouTube-RSS der Nischen-Kanäle (alle 30 min): neue Videos landen im Katalog (videos) und werden per Telegram gemeldet –
//     kein Download mehr, der Upload ist der manuelle Schritt. Backlog (scripts/yt_backlog.py) = Liste mit Titel/Aufrufen.
//   • Upload älter als 24 h ohne Clip-Job → Telegram-Hinweis (einmal je Upload).
//   • Vorrat (STOCK_DAYS × Tageslimit) unter Soll → Telegram-Hinweis, nächstes Video hochladen (max. 1× je 12 h).
import { Env, Niche, db, logEvent, mediaUrl, nichesOf, telegram } from "./shared";
import { dispatchClipJob } from "./scout";
import { accountsOf, accountRules } from "./publisher";

const RSS_EVERY_MIN = 30;
const STALE_UPLOAD_H = 24;

const nowIso = () => new Date().toISOString();
export async function niches(env: Env): Promise<Niche[]> { return nichesOf(env); }

const yt = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** Shorts-Erkennung ohne API: /shorts/<id> antwortet 200 für Shorts, 303 → /watch für normale Videos. */
export async function isShort(id: string): Promise<boolean | null> {
  try {
    const r = await fetch(`https://www.youtube.com/shorts/${id}`, { method: "HEAD", redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
    if (r.status === 200) return true;
    if (r.status >= 300 && r.status < 400) return false;
    return null;
  } catch { return null; }
}

function parseRss(xml: string): { id: string; title: string; published: string; views: number }[] {
  const out: { id: string; title: string; published: string; views: number }[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = e.match(/<yt:videoId>([^<]+)/)?.[1];
    if (!id) continue;
    out.push({ id, title: (e.match(/<title>([^<]*)/)?.[1] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
               published: e.match(/<published>([^<]+)/)?.[1] ?? nowIso(), views: Number(e.match(/views="(\d+)"/)?.[1] ?? 0) });
  }
  return out;
}

/** RSS aller Nischen-Kanäle: neue Videos → videos(source='rss') + Telegram-Hinweis zum Hochladen. */
export async function checkRss(env: Env): Promise<{ checked: number; added: string[]; errors: string[] }> {
  const res = { checked: 0, added: [] as string[], errors: [] as string[] };
  for (const n of await niches(env)) {
    for (const [cid, name] of Object.entries(n.channels)) {
      try {
        const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!r.ok) { res.errors.push(`${name}: HTTP ${r.status}`); continue; }
        res.checked++;
        for (const v of parseRss(await r.text())) {
          const known = await db.first<{ id: string; views: number }>(env, "SELECT id, views FROM videos WHERE id = ?", v.id);
          if (known) { if (v.views > (known.views ?? 0)) await db.run(env, "UPDATE videos SET views = ? WHERE id = ?", v.views, v.id); continue; }
          const short = await isShort(v.id);
          await db.run(env,
            `INSERT OR IGNORE INTO videos (id, channel_id, channel_name, title, url, published_at, views, is_short, source, status, note, niche_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rss', ?, ?, ?)`,
            v.id, cid, name, v.title, yt(v.id), v.published, v.views, short ? 1 : 0, short ? "skipped" : "new", short ? "short" : null, n.key);
          if (!short) {
            res.added.push(v.id);
            await telegram(env, `🎬 Neues Video (${n.label}): ${name} – ${v.title}\n${yt(v.id)}\n→ Dashboard → Nische ${n.label} → Footage hochladen, dann laufen die Clip-Jobs automatisch.`);
          }
        }
      } catch (e: any) { res.errors.push(`${name}: ${String(e?.message ?? e).slice(0, 80)}`); }
    }
  }
  return res;
}

/** Nach einem fertigen Upload: Fan-Kampagne der Nische anlegen und EINEN Clip-Job für alle Accounts der Nische starten. */
export async function startUploadJob(env: Env, uploadId: string, origin: string, preview = false): Promise<{ ok: boolean; campaign: string; status: number; error?: string }> {
  const u = await db.first<any>(env, "SELECT * FROM uploads WHERE id = ?", uploadId);
  if (!u) return { ok: false, campaign: "", status: 404, error: "upload not found" };
  const n = (await niches(env)).find((x) => x.key === u.niche_id);
  if (!n) return { ok: false, campaign: "", status: 404, error: `niche ${u.niche_id} not found` };
  const id = `fan-${uploadId}`;
  const url = mediaUrl(origin || env.PUBLIC_ORIGIN || "", u.key);
  const required = { caption: n.caption, hashtags: n.hashtags, tiktok: { isBrandedContent: false, isYourBrand: false } };
  await db.run(env,
    `INSERT OR IGNORE INTO campaigns (id, platform, kind, niche_id, name, external_url, status, min_views, min_seconds, footage, required, forbidden, accounts, platforms)
     VALUES (?, 'fan', 'fan', ?, ?, ?, 'active', 0, 15, ?, ?, '{}', ?, '["tiktok"]')`,
    id, n.key, `${n.label}: ${u.title || uploadId}`.slice(0, 120), u.video_id ? yt(u.video_id) : url,
    JSON.stringify({ type: "url", url, video_id: u.video_id ?? null, upload_id: uploadId }), JSON.stringify(required), JSON.stringify(n.accounts));
  const account = n.accounts.join("");
  const status = await dispatchClipJob(env, id, account, preview ? { preview: "true" } : {});
  if (status === 204) {
    await db.run(env, "UPDATE uploads SET status = 'dispatched', campaign_id = ?, updated_at = ? WHERE id = ?", id, nowIso(), uploadId);
    if (u.video_id) await db.run(env, "UPDATE videos SET status = 'queued', campaign_id = ?, dispatched_at = ?, updated_at = ? WHERE id = ?", id, nowIso(), nowIso(), u.video_id);
    await logEvent(env, `clip_job_dispatched account=${account} upload=${uploadId} (${n.key})`, id);
    await telegram(env, `📥 Footage hochgeladen (${n.label}): ${u.title || uploadId} (${Math.round((u.size ?? 0) / 1048576)} MB)\nClip-Job für ${n.accounts.join(" + ")} gestartet.`);
  } else {
    await db.run(env, "UPDATE uploads SET status = 'error', note = ?, updated_at = ? WHERE id = ?", `dispatch ${status}`, nowIso(), uploadId);
  }
  return { ok: status === 204, campaign: id, status };
}

/** Vorrat je Account (fertige/geplante Fan-Clips) und Soll = STOCK_DAYS × Tageslimit. */
export async function fanStock(env: Env) {
  const stockDays = Number(env.STOCK_DAYS || 3);
  const out: Record<string, { ready: number; target: number; deficit: number }> = {};
  for (const acc of Object.keys(accountsOf(env))) {
    const rules = await accountRules(env, acc);
    const r = await db.first<{ n: number }>(env,
      `SELECT COUNT(*) AS n FROM clips c JOIN campaigns ca ON ca.id = c.campaign_id
       WHERE c.account = ? AND ca.kind = 'fan' AND c.status IN ('ready','shadow')`, acc);
    const target = stockDays * rules.maxPerDay;
    out[acc] = { ready: r?.n ?? 0, target, deficit: Math.max(0, target - (r?.n ?? 0)) };
  }
  return out;
}

/** Fan-Lauf: RSS (alle 30 min), liegengebliebene Uploads, Vorrats-Hinweis. Startet keine Downloads mehr. */
export async function runFan(env: Env, origin = "") {
  const stats = { rss: null as any, retried: 0, stale: 0, stock: {} as any, skipped: [] as string[] };
  const last = await db.first<{ at: string }>(env, "SELECT at FROM events WHERE event LIKE 'rss_check%' ORDER BY id DESC LIMIT 1");
  if (!last || Date.now() - new Date(last.at).getTime() >= (RSS_EVERY_MIN - 1) * 60000) {
    stats.rss = await checkRss(env);
    await logEvent(env, `rss_check channels=${stats.rss.checked} new=${stats.rss.added.length}${stats.rss.errors.length ? " errors=" + stats.rss.errors.join(";") : ""}`);
  }
  // Uploads, deren Dispatch fehlgeschlagen ist: erneut versuchen (z.B. GitHub kurz nicht erreichbar)
  for (const u of await db.all<any>(env, "SELECT id FROM uploads WHERE status = 'uploaded' OR (status = 'error' AND note LIKE 'dispatch %')")) {
    if (!origin) break;
    const r = await startUploadJob(env, u.id, origin);
    if (r.ok) stats.retried++;
  }
  // Uploads älter als 24 h ohne Clip-Job → Hinweis (einmal je Upload)
  const staleSince = new Date(Date.now() - STALE_UPLOAD_H * 3600000).toISOString();
  for (const u of await db.all<any>(env, "SELECT * FROM uploads WHERE status IN ('uploaded','uploading','error') AND created_at < ? AND COALESCE(note,'') NOT LIKE '%stale_notified%'", staleSince)) {
    stats.stale++;
    await telegram(env, `⚠️ Upload seit >24 h ohne Clip-Job: ${u.title || u.id} (${u.niche_id}, Status ${u.status}${u.note ? ", " + u.note : ""}).\nDashboard → Nische → Upload prüfen oder erneut hochladen.`);
    await db.run(env, "UPDATE uploads SET note = ?, updated_at = ? WHERE id = ?", `${u.note ? u.note + "; " : ""}stale_notified`, nowIso(), u.id);
  }
  // hängende Jobs freigeben
  await db.run(env, "UPDATE videos SET status = 'new', note = 'job timeout', updated_at = ? WHERE status = 'queued' AND dispatched_at < ?",
    nowIso(), new Date(Date.now() - 150 * 60000).toISOString());
  // Vorrat: unter Soll → Hinweis, welches Video als Nächstes hochgeladen werden sollte (max. 1× je 12 h)
  stats.stock = await fanStock(env);
  const deficit = Math.max(...Object.values(stats.stock as Record<string, { deficit: number }>).map((s) => s.deficit), 0);
  const inflight = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM uploads WHERE status = 'dispatched' AND updated_at >= ?", new Date(Date.now() - 150 * 60000).toISOString());
  if (deficit > 0 && !(inflight?.n ?? 0)) {
    const warned = await db.first(env, "SELECT id FROM events WHERE event LIKE 'stock_low%' AND at >= ? LIMIT 1", new Date(Date.now() - 12 * 3600000).toISOString());
    if (!warned) {
      const next = await db.all<any>(env,
        `SELECT title, channel_name, url, views FROM videos WHERE status = 'new' AND is_short = 0 AND COALESCE(duration_s, 9999) >= 180
         ORDER BY CASE WHEN published_at >= ? THEN 0 ELSE 1 END, views DESC LIMIT 3`, new Date(Date.now() - 30 * 86400000).toISOString());
      await logEvent(env, `stock_low deficit=${deficit}`);
      await telegram(env, `📦 Fan-Vorrat unter Soll (${Object.entries(stats.stock).map(([a, s]: any) => `${a}: ${s.ready}/${s.target}`).join(", ")}).\nNächste Kandidaten zum Hochladen:\n` +
        next.map((v) => `• ${v.channel_name}: ${v.title} (${Math.round(v.views / 1e6)} M)\n  ${v.url}`).join("\n"));
    }
  }
  return stats;
}

export const isNewVideo = (publishedAt: string | null) => !!publishedAt && Date.now() - new Date(publishedAt).getTime() < 7 * 86400000;
