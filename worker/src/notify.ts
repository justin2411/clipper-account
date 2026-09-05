// Notify: täglich alle geposteten, noch nicht eingereichten URLs pro Kampagne per Telegram zum Einreichen.
import { Env, db, telegram } from "./shared";

export async function runNotify(env: Env) {
  const rows = await db.all<any>(env,
    `SELECT p.post_url, c.campaign_id, ca.name, ca.external_url, ca.platform
     FROM posts p JOIN clips c ON c.id = p.clip_id JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE p.status = 'posted' AND p.submitted_at IS NULL AND p.post_url IS NOT NULL AND p.post_url != ''`);
  const byCamp: Record<string, { name: string; url: string; platform: string; links: string[] }> = {};
  for (const r of rows) (byCamp[r.campaign_id] ??= { name: r.name, url: r.external_url ?? "", platform: r.platform, links: [] }).links.push(r.post_url);
  for (const [id, c] of Object.entries(byCamp)) {
    await telegram(env, `📎 ${c.platform.toUpperCase()} – ${c.name}: ${c.links.length} Posts einreichen\n${c.url}\n\n${c.links.join("\n")}\n\nApp → Kampagne → Add post → URLs einfügen. Danach: python scripts/mark_submitted.py ${id}`);
  }
  return { campaigns: Object.keys(byCamp).length, posts: rows.length };
}
