// Abgleich Blotato → D1: veröffentlichte Posts der letzten Tage holen und fehlende Einträge nachtragen,
// damit Views und Auszahlungen zugeordnet werden können. Drei Fälle je Blotato-Eintrag:
//   1. Post-URL steht schon in D1        → nur blotato_post_id/posted_at ergänzen
//   2. unser Post kennt die URL noch nicht → über Caption + Account zuordnen und URL/Status nachtragen
//   3. gar kein passender Post           → Clip und Post unter der Kampagne „extern" anlegen (außerhalb des Systems gepostet)
// Einträge ohne Video-URL (Blotato liefert nur die Profilseite) werden standardmäßig nur gezählt. Mit unknown=1 werden sie geführt,
// aber niemals mit der Profil-URL als post_url: die zeigt auf den Kanal statt auf das Video und würde Dashboard, Auszahlung und
// Vyro-Einreichung auf die falsche Seite schicken. Solche Posts bekommen nur die Blotato-ID, post_url bleibt leer.
import { BLOTATO, Env, blotatoHeaders, db, nowIso, logEvent, nichesOf } from "./shared";
import { accountsOf } from "./publisher";

const norm = (u: string | null | undefined) => String(u ?? "").split("?")[0].replace(/\/$/, "");
const normText = (t: string | null | undefined) => String(t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const isVideoUrl = (u: string) => /\/(video|reel|p|watch|shorts)\//.test(u) || /\/video\/\d+/.test(u);

export interface ReconcileResult {
  checked: number; linked: number; attached: number; created: number; skipped_no_video: number; unchanged: number;
  items: { blotato_id: string; url: string; account: string | null; action: string; at: string | null }[];
}

export async function reconcilePosts(env: Env, days = 14, ws = "default", dry = false, includeUnknown = false): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, linked: 0, attached: 0, created: 0, skipped_no_video: 0, unchanged: 0, items: [] };
  if (!env.BLOTATO_API_KEY) return out;
  const r = await fetch(`${BLOTATO}/published-posts?limit=100&sortBy=newest`, { headers: blotatoHeaders(env) });
  if (!r.ok) { await logEvent(env, `reconcile_error blotato ${r.status}`); return out; }
  const items: any[] = ((await r.json().catch(() => ({}))) as any)?.items ?? [];
  const since = Date.now() - days * 86400000;
  const cfg = accountsOf(env) as Record<string, any>;
  const handleOf = (url: string) => (/tiktok\.com\/@([\w.\-]+)/.exec(url) ?? [])[1] ?? null;
  const accountOfHandle = (h: string | null) => h ? (Object.entries(cfg).find(([, a]) => String(a.handle ?? "").replace(/^@/, "").toLowerCase() === h.toLowerCase())?.[0] ?? null) : null;

  for (const it of items) {
    const url = norm(it?.postUrl), created = it?.createdAt ? new Date(it.createdAt).getTime() : 0;
    if (!url || (created && created < since)) continue;
    out.checked++;
    const hasVideo = isVideoUrl(url);
    const account = accountOfHandle(handleOf(url));
    if (!hasVideo && !includeUnknown) { out.skipped_no_video++; out.items.push({ blotato_id: String(it.id), url, account, action: "ohne Video-URL übersprungen", at: it?.createdAt ?? null }); continue; }
    // Eine Profil-URL ist keine Post-URL: sie zeigt auf den Kanal, nicht auf das Video. Sie wird nie in post_url geschrieben,
    // sonst zeigen Dashboard, Auszahlungen und Vyro-Einreichung auf die falsche Seite. Mit unknown=1 wird der Eintrag nur
    // über die Blotato-ID geführt (post_url bleibt leer), damit Views später nachgetragen werden können.
    const postUrl = hasVideo ? url : null;
    if (!hasVideo) {                                            // Doppelte vermeiden: derselbe Blotato-Eintrag darf nur einmal landen
      const dup = await db.first<any>(env, "SELECT id FROM posts WHERE workspace_id = ? AND blotato_post_id = ?", ws, String(it.id));
      if (dup) { out.unchanged++; continue; }
    }

    // 1. URL bereits bekannt (nur bei echter Video-URL eindeutig)
    const known = hasVideo ? await db.first<any>(env, "SELECT id, blotato_post_id, posted_at, status FROM posts WHERE workspace_id = ? AND post_url = ?", ws, url) : null;
    if (known) {
      const sets: string[] = [], vals: unknown[] = [];
      if (!known.blotato_post_id) { sets.push("blotato_post_id = ?"); vals.push(String(it.id)); }
      if (!known.posted_at && it?.createdAt) { sets.push("posted_at = ?"); vals.push(it.createdAt); }
      if (known.status !== "posted" && known.status !== "submitted") sets.push("status = 'posted'");
      if (sets.length) { if (!dry) await db.run(env, `UPDATE posts SET ${sets.join(", ")} WHERE id = ?`, ...vals, known.id); out.linked++; out.items.push({ blotato_id: String(it.id), url, account, action: "vorhandenen Post ergänzt", at: it?.createdAt ?? null }); }
      else out.unchanged++;
      continue;
    }

    // 2. unser Post ohne URL, Caption + Account passen
    if (account) {
      // Nie einen künftig geplanten Post zuordnen und nie über 24 Stunden hinweg raten: sonst wird ein Slot von übermorgen
      // fälschlich als „gepostet“ markiert. Nur Posts, deren Zeit vor dem Blotato-Eintrag liegt und höchstens 24 h entfernt ist.
      const at = it?.createdAt ?? nowIso();
      const cands = await db.all<any>(env,
        `SELECT p.id AS post_id, p.status, p.blotato_post_id, c.caption FROM posts p JOIN clips c ON c.id = p.clip_id
         WHERE p.workspace_id = ? AND c.account = ? AND (p.post_url IS NULL OR p.post_url = '') AND p.status IN ('scheduled','posted','error')
           AND COALESCE(p.posted_at, p.scheduled_at) IS NOT NULL
           AND COALESCE(p.posted_at, p.scheduled_at) <= ?
           AND ABS((julianday(COALESCE(p.posted_at, p.scheduled_at)) - julianday(?)) * 1440) <= 1440
         ORDER BY ABS(julianday(COALESCE(p.posted_at, p.scheduled_at)) - julianday(?)) LIMIT 25`, ws, account, at, at, at);
      const hit = cands.find((c) => normText(c.caption) && normText(c.caption) === normText(it?.content));
      if (hit) {
        if (postUrl) {
          if (!dry) await db.run(env, "UPDATE posts SET post_url = ?, posted_at = COALESCE(posted_at, ?), status = 'posted', blotato_post_id = ? WHERE id = ?", postUrl, at, String(it.id), hit.post_id);
          out.attached++; out.items.push({ blotato_id: String(it.id), url, account, action: "Post über Caption zugeordnet", at: it?.createdAt ?? null });
        } else if (!hit.blotato_post_id) {                      // ohne Video-URL nur die Blotato-ID setzen, post_url bleibt leer
          if (!dry) await db.run(env, "UPDATE posts SET posted_at = COALESCE(posted_at, ?), status = 'posted', blotato_post_id = ? WHERE id = ?", at, String(it.id), hit.post_id);
          out.attached++; out.items.push({ blotato_id: String(it.id), url, account, action: "über Caption zugeordnet, Post-URL unbekannt", at: it?.createdAt ?? null });
        } else out.unchanged++;
        continue;
      }
    }

    // 3. außerhalb des Systems gepostet → Clip + Post unter „extern" anlegen
    if (!account) { out.skipped_no_video++; out.items.push({ blotato_id: String(it.id), url, account: null, action: "Account unbekannt, übersprungen", at: it?.createdAt ?? null }); continue; }
    if (!dry) {
      const niche = cfg[account]?.niche ?? nichesOf(env)[0]?.key ?? null;
      await db.run(env,
        `INSERT OR IGNORE INTO campaigns (id, platform, kind, niche_id, name, status, min_views, min_seconds, footage, required, forbidden, accounts, platforms, workspace_id)
         VALUES ('extern', 'tiktok', 'external', ?, 'Außerhalb des Systems gepostet', 'active', 0, 0, '{}', '{}', '{}', '[]', '["tiktok"]', ?)`, niche, ws);
      const clipId = crypto.randomUUID().replace(/-/g, "");
      await db.run(env,
        `INSERT INTO clips (id, workspace_id, campaign_id, account, media_url, caption, status, note, created_at)
         VALUES (?, ?, 'extern', ?, ?, ?, 'posted', ?, ?)`,
        clipId, ws, account, (it?.mediaUrls ?? [])[0] ?? null, String(it?.content ?? "").slice(0, 2000),
        postUrl ? "per Abgleich aus Blotato nachgetragen" : "per Abgleich aus Blotato nachgetragen, Post-URL unbekannt", it?.createdAt ?? nowIso());
      await db.run(env,
        `INSERT INTO posts (clip_id, workspace_id, platform, post_url, posted_at, status, mode, kind, blotato_post_id)
         VALUES (?, ?, 'tiktok', ?, ?, 'posted', 'live', 'external', ?)`, clipId, ws, postUrl, it?.createdAt ?? nowIso(), String(it.id));
    }
    out.created++; out.items.push({ blotato_id: String(it.id), url, account, action: postUrl ? "als externer Post angelegt" : "als externer Post angelegt, Post-URL unbekannt", at: it?.createdAt ?? null });
  }
  if (!dry && (out.linked || out.attached || out.created))
    await logEvent(env, `reconcile ergänzt=${out.linked} zugeordnet=${out.attached} neu=${out.created} ohne_video=${out.skipped_no_video}`);
  return out;
}
