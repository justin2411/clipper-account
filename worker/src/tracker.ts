// Tracker: holt Post-Status/URLs von Blotato, Post-Analytics (Views/Likes je Post: GET /v2/posts/{publishedPostId}/analytics),
// Tages-Snapshot je Account (account_stats: Views 7/30 Tage, Posts 7 Tage – Follower liefert Blotato nicht), Kill-Switch,
// löscht eingereichte/abgeschlossene Clips aus R2.
import { BLOTATO, Env, blotatoHeaders, db, mediaKeyFromUrl, nowIso, telegram } from "./shared";
import { accountsOf } from "./publisher";

const DROP = 0.2;
const STOP_WORDS = ["spam", "automation", "bot", "inauthentic"];

export async function runTracker(env: Env) {
  const stats = { checked: 0, posted: 0, failed: 0, archived: 0, paused: [] as string[] };
  if (env.BLOTATO_API_KEY) {
    const open = await db.all<any>(env, "SELECT * FROM posts WHERE status IN ('scheduled','posted') AND blotato_submission_id IS NOT NULL AND (post_url IS NULL OR views_7d IS NULL)");
    for (const p of open) {
      stats.checked++;
      const r = await fetch(`${BLOTATO}/posts/${p.blotato_submission_id}`, { headers: blotatoHeaders(env) });
      if (!r.ok) { console.log("[tracker] blotato", r.status, p.blotato_submission_id); continue; }
      const s: any = await r.json();
      const sets: string[] = [], vals: unknown[] = [];
      const url = s?.publicUrl ?? s?.postUrl;
      if (s?.status === "published" && !p.post_url) {
        sets.push("post_url = ?", "posted_at = ?", "status = 'posted'"); vals.push(url ?? "", nowIso()); stats.posted++;
        await db.run(env, "UPDATE clips SET status = 'posted' WHERE id = ? AND status = 'scheduled'", p.clip_id);
        const c = await db.first<any>(env, "SELECT c.seq, c.account, c.duration_s, c.hook, c.pinned_comment, c.campaign_id, ca.name, ca.kind FROM clips c JOIN campaigns ca ON ca.id = c.campaign_id WHERE c.id = ?", p.clip_id);
        if (c) await telegram(env, `📤 Gepostet (${c.kind === "fan" ? "⭐ Fan" : "💰 Paid"}): ${c.name} #${c.seq ?? "?"} (${c.account}, ${c.duration_s ? Math.round(c.duration_s) + "s" : "?"})\n${c.hook ?? ""}\n${url ?? ""}${c.pinned_comment ? `\n📌 Kommentar anpinnen: ${c.pinned_comment}` : ""}`);
      }
      const pubId = s?.publishedPostId ?? s?.publishedPost?.id ?? s?.postId ?? null;
      if (pubId && !p.blotato_post_id) { sets.push("blotato_post_id = ?"); vals.push(String(pubId)); }
      if (typeof s?.views === "number" && p.posted_at) {
        const age = (Date.now() - new Date(p.posted_at).getTime()) / 36e5;
        if (age >= 24 && p.views_24h == null) { sets.push("views_24h = ?"); vals.push(s.views); }
        if (age >= 72 && p.views_72h == null) { sets.push("views_72h = ?"); vals.push(s.views); }
        if (age >= 168 && p.views_7d == null) { sets.push("views_7d = ?"); vals.push(s.views); }
      }
      if (s?.status === "failed") {
        sets.push("status = 'rejected_platform'", "rejection_reason = ?"); vals.push(String(s?.errorMessage ?? s?.error ?? "failed")); stats.failed++;
        await db.run(env, "UPDATE clips SET status = 'rejected_platform', note = ? WHERE id = ?", String(s?.errorMessage ?? "failed").slice(0, 200), p.clip_id);
      }
      if (sets.length) await db.run(env, `UPDATE posts SET ${sets.join(", ")} WHERE id = ?`, ...vals, p.id);
    }
  }

  // Post-Analytics (Views/Likes) für gepostete Posts der letzten 30 Tage; Views-Meilensteine 24h/72h/7d daraus ableiten
  if (env.BLOTATO_API_KEY) {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const posted = await db.all<any>(env, "SELECT * FROM posts WHERE status = 'posted' AND posted_at >= ? AND blotato_post_id IS NOT NULL", since);
    for (const p of posted) {
      try {
        const r = await fetch(`${BLOTATO}/posts/${p.blotato_post_id}/analytics`, { headers: blotatoHeaders(env) });
        if (!r.ok) continue;
        const a: any = await r.json();
        const m = a?.metrics ?? a?.latestMetrics ?? {};
        const views = Number(m.viewsCount ?? m.views ?? 0), likes = Number(m.likesCount ?? m.likes ?? 0);
        const age = (Date.now() - new Date(p.posted_at).getTime()) / 36e5;
        const sets = ["views = ?", "likes = ?", "metrics_at = ?"], vals: unknown[] = [views, likes, nowIso()];
        if (age >= 24 && p.views_24h == null) { sets.push("views_24h = ?"); vals.push(views); }
        if (age >= 72 && p.views_72h == null) { sets.push("views_72h = ?"); vals.push(views); }
        if (age >= 168 && p.views_7d == null) { sets.push("views_7d = ?"); vals.push(views); }
        await db.run(env, `UPDATE posts SET ${sets.join(", ")} WHERE id = ?`, ...vals, p.id);
      } catch (e: any) { console.log("[tracker] analytics", p.id, e?.message ?? e); }
    }
  }
  // Tages-Snapshot je Account (Views/Likes der Posts der letzten 7/30 Tage, Posts 7 Tage)
  const today = new Date().toISOString().slice(0, 10);
  for (const acc of Object.keys(accountsOf(env))) {
    const agg = await db.first<any>(env,
      `SELECT SUM(CASE WHEN p.posted_at >= ? THEN COALESCE(p.views, 0) ELSE 0 END) AS v7,
              SUM(CASE WHEN p.posted_at >= ? THEN COALESCE(p.views, 0) ELSE 0 END) AS v30,
              SUM(CASE WHEN p.posted_at >= ? THEN COALESCE(p.likes, 0) ELSE 0 END) AS l30,
              SUM(CASE WHEN p.posted_at >= ? THEN 1 ELSE 0 END) AS n7
       FROM posts p JOIN clips c ON c.id = p.clip_id WHERE c.account = ? AND p.status = 'posted'`,
      new Date(Date.now() - 7 * 86400000).toISOString(), new Date(Date.now() - 30 * 86400000).toISOString(),
      new Date(Date.now() - 30 * 86400000).toISOString(), new Date(Date.now() - 7 * 86400000).toISOString(), acc);
    await db.run(env,
      `INSERT INTO account_stats (account, day, views_7d, views_30d, likes_30d, posts_7d) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account, day) DO UPDATE SET views_7d = excluded.views_7d, views_30d = excluded.views_30d, likes_30d = excluded.likes_30d, posts_7d = excluded.posts_7d`,
      acc, today, agg?.v7 ?? 0, agg?.v30 ?? 0, agg?.l30 ?? 0, agg?.n7 ?? 0);
  }

  // Kill-Switch pro Account
  for (const { account } of await db.all<{ account: string }>(env, "SELECT account FROM account_state WHERE paused = 0")) {
    const rej = await db.all<{ rejection_reason: string | null }>(env,
      "SELECT p.rejection_reason FROM posts p JOIN clips c ON c.id = p.clip_id WHERE c.account = ? AND p.status = 'rejected_platform'", account);
    if (rej.some((r) => STOP_WORDS.some((w) => (r.rejection_reason ?? "").toLowerCase().includes(w)))) {
      await db.run(env, "UPDATE account_state SET paused = 1, reason = 'rejection', updated_at = ? WHERE account = ?", nowIso(), account);
      stats.paused.push(account);
      await telegram(env, `⛔ Account ${account} pausiert: Ablehnung mit Spam/Automation-Grund. Bitte prüfen.`);
      continue;
    }
    const w = await db.all<{ views_72h: number }>(env,
      "SELECT p.views_72h FROM posts p JOIN clips c ON c.id = p.clip_id WHERE c.account = ? AND p.views_72h IS NOT NULL ORDER BY p.posted_at DESC LIMIT 40", account);
    if (w.length >= 20) {
      const avg = (xs: { views_72h: number }[]) => xs.reduce((a, b) => a + (b.views_72h ?? 0), 0) / xs.length;
      const recent = avg(w.slice(0, 10)), prev = avg(w.slice(10, 20));
      if (prev > 0 && recent < prev * DROP) {
        await db.run(env, "UPDATE account_state SET paused = 1, reason = 'views_drop', updated_at = ? WHERE account = ?", nowIso(), account);
        stats.paused.push(account);
        await telegram(env, `⚠️ Account ${account} pausiert: Views-Einbruch (${Math.round(recent)} vs ${Math.round(prev)}).`);
      }
    }
  }

  // Fan-Clips brauchen keine Einreichung: 3 Tage nach dem Posten Datei löschen und archivieren
  const fanDone = await db.all<{ id: string; media_url: string; thumb_url: string | null }>(env,
    `SELECT c.id, c.media_url, c.thumb_url FROM clips c JOIN campaigns ca ON ca.id = c.campaign_id JOIN posts p ON p.clip_id = c.id
     WHERE ca.kind = 'fan' AND c.status = 'posted' AND p.status = 'posted' AND p.posted_at < ?`, new Date(Date.now() - 3 * 86400000).toISOString());
  for (const c of fanDone) {
    for (const u of [c.media_url, c.thumb_url]) { const key = u ? mediaKeyFromUrl(u) : null; if (key) await env.CLIPS.delete(key); }
    await db.run(env, "UPDATE clips SET status = 'archived' WHERE id = ?", c.id);
    stats.archived++;
  }
  // Eingereichte Clips: Datei aus R2 löschen, Zeile archivieren
  for (const c of await db.all<{ id: string; media_url: string }>(env, "SELECT id, media_url FROM clips WHERE status = 'submitted'")) {
    const key = mediaKeyFromUrl(c.media_url);
    if (key) await env.CLIPS.delete(key);
    await db.run(env, "UPDATE clips SET status = 'archived' WHERE id = ?", c.id);
    stats.archived++;
  }
  return stats;
}
