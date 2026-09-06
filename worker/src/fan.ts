// Fan-Content (Dauerbetrieb): YouTube-RSS der MrBeast-Kanäle (alle 30 min), Video-Katalog (Backlog aus
// scripts/yt_backlog.py), Fan-Kampagnen ("fan-<videoId>", kind='fan') und Clip-Jobs (ein Job je Video,
// Account "AB": Momente Rang 1,3,5… → A, 2,4,6… → B). Vorproduktion: Vorrat von STOCK_DAYS Tagen je Account.
import { Env, db, logEvent, telegram } from "./shared";
import { dispatchClipJob } from "./scout";
import { accountsOf, accountRules } from "./publisher";

export const CHANNELS: Record<string, string> = {
  UCX6OQ3DkcsbYNE6H8uQQuVA: "MrBeast",
  UCUaT_39o1x6qWjz7K2pWcgw: "Beast Reacts",
  "UC4-79UOlP48-QNGgCko5p2g": "MrBeast 2",
  UCAiLfjNXkNv24uhpzUgPa6A: "Beast Philanthropy",
};
const RSS_EVERY_MIN = 30;
const MIN_DURATION_S = 180;               // kürzer = Short/Teaser → überspringen
const NEW_DAYS = 7;                       // "fan-neu": Video jünger als 7 Tage
const MAX_DISPATCH_PER_RUN = 3;           // Clip-Jobs je Lauf (GitHub-Runner-Parallelität)
const JOB_TIMEOUT_MIN = 240;              // 'queued' ohne Ergebnis → wieder frei

export const FAN_REQUIRED = { caption: "Credit @mrbeast", hashtags: ["#mrbeast"], tiktok: { isBrandedContent: false, isYourBrand: false } };

const yt = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Video ist Footage einer aktiven paid-Kampagne (gleicher Titel oder Video-ID in der Footage-URL) → kein Fan-Clip davon. */
export async function isPaidFootage(env: Env, videoId: string, title: string): Promise<string | null> {
  const camps = await db.all<{ id: string; name: string; footage: string }>(env, "SELECT id, name, footage FROM campaigns WHERE kind = 'paid' AND status IN ('active','joined','draft')");
  const t = norm(title);
  for (const c of camps) if ((t && norm(c.name) === t) || (c.footage ?? "").includes(videoId)) return c.id;
  return null;
}
const nowIso = () => new Date().toISOString();

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

/** RSS aller Kanäle lesen; neue Videos → videos(source='rss', status='new'). Rückgabe: neue Video-IDs. */
export async function checkRss(env: Env): Promise<{ checked: number; added: string[]; errors: string[] }> {
  const res = { checked: 0, added: [] as string[], errors: [] as string[] };
  for (const [cid, name] of Object.entries(CHANNELS)) {
    try {
      const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) { res.errors.push(`${name}: HTTP ${r.status}`); continue; }
      res.checked++;
      for (const v of parseRss(await r.text())) {
        const known = await db.first<{ id: string; views: number }>(env, "SELECT id, views FROM videos WHERE id = ?", v.id);
        if (known) { if (v.views > (known.views ?? 0)) await db.run(env, "UPDATE videos SET views = ?, updated_at = ? WHERE id = ?", v.views, nowIso(), v.id); continue; }
        const short = await isShort(v.id);
        await db.run(env,
          `INSERT OR IGNORE INTO videos (id, channel_id, channel_name, title, url, published_at, views, is_short, source, status, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rss', ?, ?)`,
          v.id, cid, name, v.title, yt(v.id), v.published, v.views, short ? 1 : 0, short ? "skipped" : "new", short ? "short" : null);
        if (!short) res.added.push(v.id);
      }
    } catch (e: any) { res.errors.push(`${name}: ${String(e?.message ?? e).slice(0, 80)}`); }
  }
  return res;
}

/** Fan-Kampagne für ein Video anlegen (idempotent) und EINEN Clip-Job (Account AB) starten. */
export async function startFanJob(env: Env, videoId: string): Promise<{ ok: boolean; campaign: string; status: number }> {
  const v = await db.first<any>(env, "SELECT * FROM videos WHERE id = ?", videoId);
  if (!v) return { ok: false, campaign: "", status: 404 };
  const paid = await isPaidFootage(env, videoId, v.title ?? "");
  if (paid) {
    await db.run(env, "UPDATE videos SET status = 'skipped', note = ?, updated_at = ? WHERE id = ?", `paid campaign ${paid}`, nowIso(), videoId);
    return { ok: false, campaign: paid, status: 409 };
  }
  const id = `fan-${videoId}`;
  await db.run(env,
    `INSERT OR IGNORE INTO campaigns (id, platform, kind, name, external_url, status, min_views, min_seconds, footage, required, forbidden, accounts, platforms)
     VALUES (?, 'fan', 'fan', ?, ?, 'active', 0, 15, ?, ?, '{}', '["A","B"]', '["tiktok"]')`,
    id, `${v.channel_name}: ${v.title}`.slice(0, 120), v.url, JSON.stringify({ type: "youtube", url: v.url, video_id: videoId }), JSON.stringify(FAN_REQUIRED));
  const status = await dispatchClipJob(env, id, "AB");
  if (status === 204) {
    await db.run(env, "UPDATE videos SET status = 'queued', campaign_id = ?, dispatched_at = ?, updated_at = ? WHERE id = ?", id, nowIso(), nowIso(), videoId);
    await logEvent(env, `clip_job_dispatched account=AB video=${videoId} (${v.source})`, id);
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

/** Fan-Lauf: RSS (alle 30 min) → neue Videos sofort clippen; sonst Backlog nachfüllen, bis der Vorrat reicht. */
export async function runFan(env: Env) {
  const stats = { rss: null as any, new_jobs: 0, backlog_jobs: 0, stock: {} as any, skipped: [] as string[] };
  // 1) RSS, gedrosselt auf alle 30 Minuten (Scout läuft alle 10)
  const last = await db.first<{ at: string }>(env, "SELECT at FROM events WHERE event LIKE 'rss_check%' ORDER BY id DESC LIMIT 1");
  if (!last || Date.now() - new Date(last.at).getTime() >= (RSS_EVERY_MIN - 1) * 60000) {
    stats.rss = await checkRss(env);
    await logEvent(env, `rss_check channels=${stats.rss.checked} new=${stats.rss.added.length}${stats.rss.errors.length ? " errors=" + stats.rss.errors.join(";") : ""}`);
    for (const id of stats.rss.added) {
      const v = await db.first<any>(env, "SELECT * FROM videos WHERE id = ?", id);
      const r = await startFanJob(env, id);
      if (r.ok) { stats.new_jobs++; await telegram(env, `🎬 Neues Video: ${v.channel_name} – ${v.title}\n${v.url}\nClip-Job für A und B gestartet.`); }
      else if (r.status === 409) { stats.skipped.push(`${id}: Footage der paid-Kampagne ${r.campaign}`); await telegram(env, `🎬 Neues Video: ${v.channel_name} – ${v.title}\nIst Footage der paid-Kampagne ${r.campaign} → kein Fan-Clip.`); }
      else stats.skipped.push(`${id}: dispatch ${r.status}`);
    }
  }
  // hängende Jobs freigeben
  await db.run(env, "UPDATE videos SET status = 'new', note = 'job timeout', updated_at = ? WHERE status = 'queued' AND dispatched_at < ?",
    nowIso(), new Date(Date.now() - JOB_TIMEOUT_MIN * 60000).toISOString());
  // 2) Backlog nachfüllen, wenn der Vorrat unter dem Soll liegt – außer YouTube blockt den Download (Bot-Check):
  //    dann keine weiteren Jobs starten (Actions-Minuten), bis wieder ein Download geklappt hat (Cookies/YT_COOKIES_B64)
  stats.stock = await fanStock(env);
  const since = new Date(Date.now() - 6 * 3600000).toISOString();
  const bot = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM videos WHERE status = 'error' AND note = 'bot check' AND updated_at >= ?", since);
  const okSince = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM videos WHERE status = 'clipped' AND updated_at >= ?", since);
  if ((bot?.n ?? 0) >= 2 && !(okSince?.n ?? 0)) {
    (stats as any).blocked = "youtube bot check";
    const warned = await db.first(env, "SELECT id FROM events WHERE event LIKE 'fan blocked%' AND at >= ? LIMIT 1", new Date(Date.now() - 24 * 3600000).toISOString());
    if (!warned) {
      await logEvent(env, `fan blocked: youtube bot check (${bot?.n} Fehler in 6 h) – Backlog-Jobs pausiert bis YT_COOKIES_B64 gesetzt ist`);
      await telegram(env, `⛔ Fan-Content pausiert: YouTube blockt den Download in GitHub Actions („Sign in to confirm you're not a bot“).\nLösung: GitHub-Secret YT_COOKIES_B64 setzen (Anleitung NEXT_STEPS.md). Danach: python scripts/run_fn.py fan`);
    }
    return stats;
  }
  const deficit = Math.max(...Object.values(stats.stock as Record<string, { deficit: number }>).map((s) => s.deficit), 0);
  const inflight = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM videos WHERE status = 'queued'");
  const perJob = 3;                                            // ≈3 Clips je Account und Video
  let want = Math.min(MAX_DISPATCH_PER_RUN, Math.max(0, Math.ceil(deficit / perJob) - (inflight?.n ?? 0)));
  if (want > 0 && !stats.new_jobs) {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const next = await db.all<any>(env,
      `SELECT * FROM videos WHERE status = 'new' AND is_short = 0 AND COALESCE(duration_s, 9999) >= ?
       ORDER BY CASE WHEN published_at >= ? THEN 0 ELSE 1 END, views DESC LIMIT ?`, MIN_DURATION_S, cutoff, want);
    for (const v of next) {
      const r = await startFanJob(env, v.id);
      if (r.ok) stats.backlog_jobs++; else stats.skipped.push(`${v.id}: ${r.status === 409 ? "paid-Footage " + r.campaign : "dispatch " + r.status}`);
    }
  }
  return stats;
}

/** Fan-Kampagnen ohne offene Clips gelten als beendet (Aufräumen für Dashboard/Publisher). */
export const isNewVideo = (publishedAt: string | null) => !!publishedAt && Date.now() - new Date(publishedAt).getTime() < NEW_DAYS * 86400000;
