// Account-Gesundheit (Nachtrag 1): Ampel je Account aus echten Daten.
//   • Trend: Ø Views der letzten 10 geposteten Clips vs. der 10 davor
//   • Anteil der letzten 10 Posts unter 200 Views
//   • Engagement-Rate (Likes ÷ Views) der letzten 10
//   • Tage seit dem letzten Post
//   • Kill-Switch-Historie (Pausen durch Ablehnung/Views-Einbruch, Regeln, Freigaben) aus events
// rot → Deep-Link in den Chat („Warum ist X rot?"). Tiefe 1 = Farbe + ein Satz, Tiefe 2 = Kennzahlen, Tiefe 3 = Historie.
import { Env, db } from "./shared";

export type HealthColor = "green" | "yellow" | "red" | "grey";
export interface Health {
  color: HealthColor; headline: string; reasons: string[]; question: string;
  metrics: { posts_with_views: number; avg_last10: number | null; avg_prev10: number | null; trend_pct: number | null; under_200_pct: number | null;
             engagement_pct: number | null; days_since_post: number | null; paused: boolean; pause_reason: string | null; kill_switches_30d: number };
  history: { at: string; text: string }[];
}

export async function accountHealth(env: Env, account: string, ws = "default"): Promise<Health> {
  const posts = await db.all<any>(env,
    `SELECT p.posted_at, COALESCE(p.views, p.views_7d, p.views_72h, p.views_24h) AS views, COALESCE(p.likes, 0) AS likes
     FROM posts p JOIN clips c ON c.id = p.clip_id
     WHERE p.workspace_id = ? AND c.account = ? AND p.status IN ('posted','submitted') AND p.mode != 'shadow' AND p.posted_at IS NOT NULL
     ORDER BY p.posted_at DESC LIMIT 20`, ws, account);
  const st = await db.first<any>(env, "SELECT paused, reason FROM account_state WHERE workspace_id = ? AND account = ?", ws, account);
  const hist = await db.all<{ at: string; event: string }>(env,
    `SELECT at, event FROM events WHERE workspace_id = ? AND (event LIKE ? OR event LIKE ? OR event LIKE ? OR event LIKE ?) ORDER BY id DESC LIMIT 10`,
    ws, `kill_switch ${account}%`, `account_rules ${account}:%`, `account_resumed ${account}%`, `account_paused ${account}%`);
  const withViews = posts.filter((p) => p.views != null && Number(p.views) > 0);     // 0 = Analytics noch nicht geliefert (Blotato), nicht „0 Views"
  const last10 = withViews.slice(0, 10), prev10 = withViews.slice(10, 20);
  const avg = (ps: any[]) => (ps.length ? Math.round(ps.reduce((a, p) => a + Number(p.views), 0) / ps.length) : null);
  const avgLast = avg(last10), avgPrev = avg(prev10);
  const trend = avgLast != null && avgPrev != null && avgPrev > 0 && prev10.length >= 5 ? Math.round(((avgLast - avgPrev) / avgPrev) * 100) : null;
  const under200 = last10.length ? Math.round((last10.filter((p) => Number(p.views) < 200).length / last10.length) * 100) : null;
  const views = last10.reduce((a, p) => a + Number(p.views), 0), likes = last10.reduce((a, p) => a + Number(p.likes), 0);
  const engagement = views > 0 ? Math.round((likes / views) * 1000) / 10 : null;
  const lastPost = posts[0]?.posted_at ?? null;
  const days = lastPost ? Math.round(((Date.now() - new Date(lastPost).getTime()) / 86400000) * 10) / 10 : null;
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const kills = hist.filter((h) => h.at >= since30 && /kill_switch|paused=1|account_paused/.test(h.event)).length;
  const paused = !!st?.paused, reason = st?.reason ?? null;
  const killPause = paused && ["rejection", "views_drop"].includes(String(reason));

  const reasons: string[] = [];
  let color: HealthColor = "green";
  if (withViews.length < 3) { color = "grey"; reasons.push(posts.length ? `${posts.length} Posts, aber erst ${withViews.length} mit Views-Daten – noch keine Bewertung (Analytics kommen verzögert).` : "Noch keine Posts."); }
  if (killPause) { color = "red"; reasons.push(`Kill-Switch aktiv: ${reason === "rejection" ? "Ablehnung mit Spam/Automation-Grund" : "Views-Einbruch"}.`); }
  if (trend != null && trend <= -50) { color = "red"; reasons.push(`Ø Views der letzten 10 Posts ${trend} % unter den 10 davor (${avgLast} vs. ${avgPrev}).`); }
  else if (trend != null && trend <= -20) { if (color !== "red") color = "yellow"; reasons.push(`Ø Views ${trend} % unter den vorherigen 10 Posts.`); }
  if (under200 != null && under200 >= 70 && last10.length >= 5) { color = "red"; reasons.push(`${under200} % der letzten Posts unter 200 Views.`); }
  else if (under200 != null && under200 >= 40 && last10.length >= 5) { if (color !== "red") color = "yellow"; reasons.push(`${under200} % der letzten Posts unter 200 Views.`); }
  if (days != null && days >= 3 && !paused) { color = "red"; reasons.push(`Seit ${Math.floor(days)} Tagen kein Post.`); }
  else if (days != null && days >= 2 && !paused) { if (color !== "red") color = "yellow"; reasons.push(`Seit ${Math.floor(days)} Tagen kein Post.`); }
  if (engagement != null && engagement < 1 && views >= 1000) { if (color !== "red") color = "yellow"; reasons.push(`Engagement nur ${engagement} % (Likes ÷ Views).`); }
  if (paused && !killPause) reasons.push(`Pausiert (${reason ?? "Regel"}) – geplante Pause, kein Alarm.`);
  if (color === "green" && !reasons.length) reasons.push(withViews.length ? `Stabil: Ø ${avgLast} Views, ${under200 ?? 0} % unter 200, letzter Post vor ${days ?? "–"} Tagen.` : "Keine Auffälligkeiten.");
  const headline = color === "red" ? "Handlungsbedarf" : color === "yellow" ? "Beobachten" : color === "grey" ? "Zu wenig Daten" : "Gesund";
  return {
    color, headline, reasons, question: `Warum ist ${account} ${color === "red" ? "rot" : color === "yellow" ? "gelb" : color === "grey" ? "grau" : "grün"}?`,
    metrics: { posts_with_views: withViews.length, avg_last10: avgLast, avg_prev10: avgPrev, trend_pct: trend, under_200_pct: under200, engagement_pct: engagement,
               days_since_post: days, paused, pause_reason: reason, kill_switches_30d: kills },
    history: hist.map((h) => ({ at: h.at, text: h.event.replace(/\s*run=\d+/, "") })),
  };
}
