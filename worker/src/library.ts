// Clip-Bibliothek (Nachtrag 6): alle gerenderten Clips mit Suche und Filtern (Quelle, Hook, Score, Status, Views).
// „Erneut verwenden auf Instagram/YouTube" legt einen neuen Clip mit derselben Datei für die Zielplattform an (Status ready) –
// der Publisher plant ihn im nächsten freien Slot des Accounts. Die Plattform muss im Blotato-Konto des Accounts hinterlegt sein.
import { Env, db, nowIso, logEvent } from "./shared";
import { accountsOf } from "./publisher";

const PLATFORMS = ["instagram", "youtube", "tiktok"] as const;

export async function listLibrary(env: Env, o: { q?: string; status?: string; account?: string; source?: string; min_score?: number; min_views?: number; sort?: string; limit?: number; offset?: number }, ws = "default") {
  const limit = Math.min(120, Math.max(10, Number(o.limit) || 40)), offset = Math.max(0, Number(o.offset) || 0);
  const where = ["c.workspace_id = ?", "c.media_url IS NOT NULL", "c.status NOT IN ('rejected_precheck','superseded')"]; const args: unknown[] = [ws];
  if (o.q) { where.push("(c.hook LIKE ? OR c.context_line LIKE ? OR c.caption LIKE ? OR ca.name LIKE ?)"); const q = `%${o.q}%`; args.push(q, q, q, q); }
  if (o.status && o.status !== "all") { where.push("c.status = ?"); args.push(o.status); }
  if (o.account && o.account !== "all") { where.push("c.account = ?"); args.push(String(o.account).toUpperCase()); }
  if (o.source && o.source !== "all") { where.push(o.source === "fan" ? "COALESCE(ca.kind,'paid') = 'fan'" : o.source === "paid" ? "COALESCE(ca.kind,'paid') = 'paid'" : "ca.id = ?"); if (!["fan", "paid"].includes(o.source)) args.push(o.source); }
  const sort = o.sort === "views" ? "views DESC" : o.sort === "score" ? "score DESC" : o.sort === "oldest" ? "c.created_at ASC" : "c.created_at DESC";
  const rows = await db.all<any>(env,
    `SELECT c.id, c.account, c.status, c.created_at, c.hook, c.context_line, c.caption, c.duration_s, c.media_url, c.cover_url, c.thumb_url, c.scores, c.qa, c.variant, c.rank, c.video_id,
            c.campaign_id, ca.name AS campaign, COALESCE(ca.kind,'paid') AS kind, ca.niche_id,
            (SELECT MAX(COALESCE(p.views, p.views_7d, p.views_72h, p.views_24h)) FROM posts p WHERE p.clip_id = c.id) AS views,
            (SELECT MAX(p.post_url) FROM posts p WHERE p.clip_id = c.id AND p.post_url IS NOT NULL) AS post_url,
            (SELECT GROUP_CONCAT(DISTINCT p.platform) FROM posts p WHERE p.clip_id = c.id AND p.status IN ('posted','submitted','scheduled','shadow')) AS platforms,
            CAST(json_extract(c.scores, '$.total') AS REAL) AS score
     FROM clips c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE ${where.join(" AND ")} ${o.min_score ? "AND CAST(json_extract(c.scores, '$.total') AS REAL) >= " + Number(o.min_score) : ""}
     ${o.min_views ? "AND (SELECT MAX(COALESCE(p.views, p.views_7d)) FROM posts p WHERE p.clip_id = c.id) >= " + Number(o.min_views) : ""}
     ORDER BY ${sort} LIMIT ? OFFSET ?`, ...args, limit, offset);
  const total = await db.first<any>(env, `SELECT COUNT(*) AS n FROM clips c LEFT JOIN campaigns ca ON ca.id = c.campaign_id WHERE ${where.join(" AND ")}`, ...args);
  const statuses = await db.all<any>(env, "SELECT status, COUNT(*) AS n FROM clips WHERE workspace_id = ? AND media_url IS NOT NULL AND status NOT IN ('rejected_precheck','superseded') GROUP BY status", ws);
  const sources = await db.all<any>(env, "SELECT ca.id, ca.name, COALESCE(ca.kind,'paid') AS kind, COUNT(*) AS n FROM clips c JOIN campaigns ca ON ca.id = c.campaign_id WHERE c.workspace_id = ? GROUP BY ca.id ORDER BY n DESC LIMIT 30", ws);
  return {
    total: Number(total?.n ?? 0), limit, offset,
    items: rows.map((c) => ({
      id: c.id, account: c.account, status: c.status, created_at: c.created_at, hook: c.context_line ?? c.hook ?? "", caption: String(c.caption ?? "").split("\n")[0],
      duration_s: c.duration_s, media_url: c.media_url, cover: c.cover_url ?? c.thumb_url ?? null, score: c.score ?? null,
      scores: c.scores ? JSON.parse(c.scores) : null, qa: c.qa ? JSON.parse(c.qa) : null, variant: c.variant, rank: c.rank,
      campaign: c.campaign ?? (c.kind === "fan" ? "Fan-Content" : ""), campaign_id: c.campaign_id, kind: c.kind, niche: c.niche_id,
      views: c.views ?? null, post_url: c.post_url ?? null, platforms: String(c.platforms ?? "").split(",").filter(Boolean),
      reusable: !!c.media_url && !["rejected_review", "test_private"].includes(c.status),
    })),
    filters: { statuses: Object.fromEntries(statuses.map((s) => [s.status, Number(s.n)])), sources: sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, n: Number(s.n) })), accounts: Object.keys(accountsOf(env)) },
  };
}

/** Erneut verwenden: neuen Clip mit derselben Datei für eine andere Plattform anlegen (Status ready → Publisher plant ihn ein). */
export async function reuseClip(env: Env, clipId: string, platform: string, ws = "default") {
  if (!PLATFORMS.includes(platform as any)) return { ok: false, error: `Plattform ${platform} nicht unterstützt (${PLATFORMS.join(", ")})` };
  const c = await db.first<any>(env, "SELECT * FROM clips WHERE id = ? AND workspace_id = ?", clipId, ws);
  if (!c) return { ok: false, error: "Clip nicht gefunden" };
  if (!c.media_url) return { ok: false, error: "Clip hat keine Datei" };
  const acc = accountsOf(env)[c.account] as any;
  if (!acc?.blotato?.[platform]) return { ok: false, error: `Für ${c.account} ist kein ${platform}-Konto in Blotato hinterlegt (config/accounts.yaml → blotato.${platform})` };
  const already = await db.first<any>(env,
    `SELECT p.id FROM posts p JOIN clips cl ON cl.id = p.clip_id WHERE cl.workspace_id = ? AND cl.media_url = ? AND p.platform = ? AND p.status IN ('scheduled','shadow','posted','submitted')`, ws, c.media_url, platform);
  if (already) return { ok: false, error: `Dieser Clip ist auf ${platform} bereits geplant oder gepostet` };
  const camp = await db.first<any>(env, "SELECT id, platforms FROM campaigns WHERE id = ?", c.campaign_id);
  if (camp) {                                                        // Zielplattform in der Kampagne freischalten, sonst plant der Publisher sie nicht
    let list: string[] = []; try { list = JSON.parse(camp.platforms || "[]"); } catch { list = []; }
    if (!list.includes(platform)) await db.run(env, "UPDATE campaigns SET platforms = ? WHERE id = ?", JSON.stringify([...list, platform]), camp.id);
  }
  const id = crypto.randomUUID().replace(/-/g, "");
  await db.run(env,
    `INSERT INTO clips (id, workspace_id, campaign_id, account, media_url, caption, hook_type, status, note, seq, duration_s, hook, pinned_comment, video_id, rank, thumb_url, context_line, cover_url, scores, variant, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ws, c.campaign_id, c.account, c.media_url, c.caption, c.hook_type, `reuse:${platform} von ${clipId}`, c.seq, c.duration_s, c.hook, c.pinned_comment,
    c.video_id, c.rank, c.thumb_url, c.context_line, c.cover_url, c.scores, c.variant, nowIso());
  await logEvent(env, `clip_reused ${clipId} → ${id} platform=${platform} account=${c.account}`, c.campaign_id);
  return { ok: true, clip_id: id, from: clipId, platform, account: c.account, note: "Der Publisher plant den Clip im nächsten freien Slot des Accounts." };
}
