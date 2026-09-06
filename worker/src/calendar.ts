// Kalender (Nachtrag 4): Woche je Account – geplante und bereits gepostete Beiträge mit Clip-Vorschau (Cover), Kampagne und Slot.
// Verschieben per Drag (oder Auswahl auf dem Handy) ruft moveSlot aus chat.ts: Schatten-Post nur umdatieren, Live-Post über Blotato
// neu planen. Kollisionsschutz: Mindestabstand des Accounts (Feinjustierung) wird vor dem Verschieben geprüft.
import { Env, db, nichesOf } from "./shared";
import { accountsOf } from "./publisher";
import { effectiveSettings } from "./settings";
import { moveSlot } from "./chat";

const startOfWeek = (d: Date) => { const s = new Date(d); s.setUTCHours(0, 0, 0, 0); s.setUTCDate(s.getUTCDate() - ((s.getUTCDay() || 7) - 1)); return s; };

export async function buildCalendar(env: Env, weekOffset = 0, ws = "default") {
  const from = startOfWeek(new Date()); from.setUTCDate(from.getUTCDate() + weekOffset * 7);
  const to = new Date(from.getTime() + 7 * 86400000);
  const rows = await db.all<any>(env,
    `SELECT p.id, p.status, p.mode, p.scheduled_at, p.posted_at, p.post_url, COALESCE(p.views, p.views_7d) AS views,
            COALESCE(p.kind, ca.kind, 'paid') AS kind, c.id AS clip_id, c.account, c.hook, c.context_line, c.cover_url, c.thumb_url, c.duration_s,
            c.campaign_id, ca.name AS campaign, ca.niche_id
     FROM posts p JOIN clips c ON c.id = p.clip_id LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE p.workspace_id = ? AND p.status IN ('scheduled','shadow','posted','submitted')
       AND COALESCE(p.scheduled_at, p.posted_at) >= ? AND COALESCE(p.scheduled_at, p.posted_at) < ?
     ORDER BY COALESCE(p.scheduled_at, p.posted_at)`, ws, from.toISOString(), to.toISOString());
  const cfg = accountsOf(env);
  const accounts = [] as any[];
  for (const [id, a] of Object.entries(cfg) as [string, any][]) {
    const eff = await effectiveSettings(env, id, ws).catch(() => null);
    const st = await db.first<any>(env, "SELECT paused, reason, paused_until FROM account_state WHERE workspace_id = ? AND account = ?", ws, id);
    accounts.push({ id, handle: a.handle, niche: a.niche ?? nichesOf(env).find((n) => n.accounts.includes(id))?.key ?? null,
                    slots: eff?.settings.slots ?? a.slots ?? [], posts_per_day: eff?.settings.posts_per_day ?? null, min_gap_min: eff?.settings.min_gap_min ?? null,
                    paused: !!st?.paused, paused_until: st?.paused_until ?? null });
  }
  const items = rows.map((r) => ({
    id: r.id, clip_id: r.clip_id, account: r.account, at: r.scheduled_at ?? r.posted_at, status: r.status, mode: r.mode, kind: r.kind,
    hook: r.context_line ?? r.hook ?? "", cover: r.cover_url ?? r.thumb_url ?? null, duration_s: r.duration_s ?? null, campaign: r.campaign ?? (r.kind === "fan" ? "Fan-Content" : ""),
    campaign_id: r.campaign_id, niche: r.niche_id, url: r.post_url, views: r.views ?? null,
    movable: ["scheduled", "shadow"].includes(r.status) && new Date(r.scheduled_at ?? 0).getTime() > Date.now(),
  }));
  const days = Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * 86400000).toISOString().slice(0, 10));
  return { from: from.toISOString(), to: to.toISOString(), week_offset: weekOffset, days, accounts, items };
}

/** Verschieben mit Kollisionsschutz (Mindestabstand des Accounts, nie zwei Posts im selben Fenster). */
export async function moveCalendarPost(env: Env, postId: string, at: string, ws = "default") {
  const p = await db.first<any>(env, "SELECT p.id, p.scheduled_at, p.status, c.account FROM posts p JOIN clips c ON c.id = p.clip_id WHERE p.id = ? AND p.workspace_id = ?", postId, ws);
  if (!p) return { ok: false, error: "Post nicht gefunden" };
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "Zeitpunkt ungültig" };
  if (when.getTime() < Date.now() + 60000) return { ok: false, error: "Zeitpunkt liegt in der Vergangenheit" };
  const eff = await effectiveSettings(env, p.account, ws).catch(() => null);
  const gap = Number(eff?.settings.min_gap_min ?? env.POST_GAP_MIN ?? 90);
  const near = await db.first<any>(env,
    `SELECT p.id, p.scheduled_at FROM posts p JOIN clips c ON c.id = p.clip_id
     WHERE p.workspace_id = ? AND c.account = ? AND p.id != ? AND p.status IN ('scheduled','shadow','posted','submitted')
       AND ABS((julianday(p.scheduled_at) - julianday(?)) * 1440) < ?`, ws, p.account, p.id, when.toISOString(), gap);
  if (near) return { ok: false, error: `Kollision: ${p.account} hat um ${new Date(near.scheduled_at).toISOString().slice(11, 16)} UTC schon einen Post (Mindestabstand ${gap} min).` };
  const perDay = Number(eff?.settings.posts_per_day ?? env.MAX_CLIPS_PER_DAY ?? 5);
  const sameDay = await db.first<any>(env,
    `SELECT COUNT(*) AS n FROM posts p JOIN clips c ON c.id = p.clip_id
     WHERE p.workspace_id = ? AND c.account = ? AND p.id != ? AND p.status IN ('scheduled','shadow','posted','submitted') AND substr(COALESCE(p.scheduled_at, p.posted_at),1,10) = ?`,
    ws, p.account, p.id, when.toISOString().slice(0, 10));
  if ((sameDay?.n ?? 0) >= perDay) return { ok: false, error: `Tageslimit erreicht: ${p.account} hat an diesem Tag bereits ${sameDay.n} von ${perDay} Posts.` };
  return moveSlot(env, postId, when.toISOString(), ws);
}
