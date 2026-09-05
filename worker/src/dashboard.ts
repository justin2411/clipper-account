// GET /dashboard – Datenvertrag aus dashboard/index.html (Kommentar am Dateianfang).
// Views kommen erst, wenn eine Views-Quelle angebunden ist (Blotato liefert keine) → views/qualified/earned
// rechnen mit dem jeweils neuesten vorhandenen Wert (views_7d → views_72h → views_24h), sonst 0.
import { Env, db } from "./shared";
import { accountsOf } from "./publisher";

const BLOTATO_FIXED_USD = 29, LLM_PER_CLIP_USD = 0.01, EUR_RATE = 0.92, GOAL_MONTHLY = 2000;
const NICHE: Record<string, string> = { moments: "Momente", reactions: "Reaktionen" };

const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t.getTime() - y0.getTime()) / 86400000) + 1) / 7);
};

export async function buildDashboard(env: Env) {
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const monthStart = `${month}-01`;
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();

  // Umsatz = Auszahlungen (Scout liest Payout-Mails / manuell)
  const rev = await db.first<{ s: number }>(env, "SELECT COALESCE(SUM(amount_usd),0) AS s FROM payouts WHERE at >= ?", monthStart);
  const revWeek = await db.first<{ s: number }>(env, "SELECT COALESCE(SUM(amount_usd),0) AS s FROM payouts WHERE at >= ?", weekAgo);
  const clipsMonth = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM clips WHERE created_at >= ? AND status NOT IN ('rejected_precheck')", monthStart);
  const costsTable = await db.first<{ s: number }>(env, "SELECT COALESCE(SUM(amount_usd),0) AS s FROM costs WHERE at >= ?", monthStart);
  const costs = Math.round((BLOTATO_FIXED_USD + LLM_PER_CLIP_USD * (clipsMonth?.n ?? 0) + (costsTable?.s ?? 0)) * 100) / 100;

  // Posts mit neuestem Views-Stand
  const posts = await db.all<any>(env,
    `SELECT p.id, p.status, p.post_url, p.posted_at, p.submitted_at, p.scheduled_at,
            COALESCE(p.views_7d, p.views_72h, p.views_24h) AS views,
            c.campaign_id, c.account, c.hook_type, ca.name AS camp_name, ca.rate_per_1k_usd, ca.min_views, ca.max_per_post_usd
     FROM posts p JOIN clips c ON c.id = p.clip_id JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE p.status IN ('scheduled','posted')`);
  const earnedOf = (p: any) => {
    const v = p.views ?? 0, rate = p.rate_per_1k_usd ?? 0;
    if (v < (p.min_views ?? 0)) return 0;
    return Math.min((v / 1000) * rate, p.max_per_post_usd ?? Infinity);
  };
  const pending = Math.round(posts.filter((p) => p.status === "posted").reduce((a, p) => a + earnedOf(p), 0));

  // History: letzte 8 Kalenderwochen (Auszahlungen)
  const history: { week: string; revenue: number }[] = [];
  for (let i = 7; i >= 0; i--) {
    const start = new Date(now.getTime() - (i * 7 + ((now.getUTCDay() || 7) - 1)) * 86400000); start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 7 * 86400000);
    const r = await db.first<{ s: number }>(env, "SELECT COALESCE(SUM(amount_usd),0) AS s FROM payouts WHERE at >= ? AND at < ?", start.toISOString(), end.toISOString());
    history.push({ week: `KW${isoWeek(start)}`, revenue: Math.round(r?.s ?? 0) });
  }

  // Kampagnen
  const campRows = await db.all<any>(env, "SELECT * FROM campaigns ORDER BY created_at DESC");
  const clipCounts = await db.all<{ campaign_id: string; n: number }>(env, "SELECT campaign_id, COUNT(*) AS n FROM clips WHERE status NOT IN ('rejected_precheck','rejected_review','test_private') GROUP BY campaign_id");
  const campaigns = campRows.map((c) => {
    const ps = posts.filter((p) => p.campaign_id === c.id && p.status === "posted");
    const views = ps.reduce((a, p) => a + (p.views ?? 0), 0);
    const qualified = ps.filter((p) => (p.views ?? 0) >= (c.min_views ?? 0) && (p.views ?? 0) > 0).length;
    const earned = Math.round(ps.reduce((a, p) => a + earnedOf(p), 0));
    return { id: c.id, name: c.name, platform: c.platform, status: c.status === "draft" ? "joined" : c.status,
      rate_per_1k: c.rate_per_1k_usd ?? 0, clips: clipCounts.find((x) => x.campaign_id === c.id)?.n ?? 0,
      views, qualified, earned, budget_used: c.budget_used_usd ?? 0, budget_total: c.budget_total_usd ?? 0 };
  });

  // Accounts
  const state = await db.all<any>(env, "SELECT * FROM account_state");
  const cfg = accountsOf(env) as Record<string, any>;
  const accounts = Object.entries(cfg).map(([id, a]) => {
    const st = state.find((s) => s.account === id);
    const ps = posts.filter((p) => p.account === id && p.status === "posted" && p.views != null);
    const avg = ps.length ? Math.round(ps.reduce((x, p) => x + p.views, 0) / ps.length) : 0;
    return { id, handle: a.handle ?? "", niche: NICHE[a.niche ?? a.style ?? ""] ?? (a.niche ?? a.style ?? ""), followers: a.followers ?? 0,
      avg_views: avg, paused: !!st?.paused, reason: st?.reason ?? null };
  });

  // Insights (nur mit Views-Daten aussagekräftig)
  const withViews = posts.filter((p) => p.status === "posted" && p.views != null);
  const groupAvg = (key: (p: any) => string) => {
    const m: Record<string, number[]> = {};
    for (const p of withViews) (m[key(p)] ??= []).push(p.views);
    return Object.entries(m).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length] as const).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "–";
  };
  const postedAll = posts.filter((p) => p.status === "posted");
  const insights = {
    best_hook: withViews.length ? ({ moment: "Moment-Clip", reaction: "Reaktions-Clip" } as any)[groupAvg((p) => p.hook_type ?? "–")] ?? groupAvg((p) => p.hook_type ?? "–") : "–",
    best_slot: withViews.length ? groupAvg((p) => (p.scheduled_at ?? "").slice(11, 16) + " UTC") : "–",
    qualified_rate: postedAll.length ? withViews.filter((p) => p.views >= (p.min_views ?? 0)).length / postedAll.length : 0,
  };

  // Aufgaben
  const tasks: { type: string; text: string; url?: string }[] = [];
  const toSubmit: Record<string, { n: number; name: string; url: string }> = {};
  for (const p of posts.filter((p) => p.status === "posted" && !p.submitted_at && p.post_url)) {
    const c = campRows.find((x) => x.id === p.campaign_id);
    (toSubmit[p.campaign_id] ??= { n: 0, name: p.camp_name, url: c?.external_url ?? "https://app.vyro.com" }).n++;
  }
  for (const t of Object.values(toSubmit)) tasks.push({ type: "submit", text: `${t.n} Post-Link${t.n > 1 ? "s" : ""} bei Vyro einreichen – ${t.name}`, url: t.url });
  for (const c of campRows.filter((c) => c.status === "draft"))
    tasks.push({ type: "join", text: `Neue Kampagne wartet auf Join – ${c.name}${c.rate_per_1k_usd ? `, ${c.rate_per_1k_usd} $/1k` : ""}`, url: c.external_url || "https://app.vyro.com" });
  for (const s of state.filter((s) => s.paused))
    tasks.push({ type: "review", text: `Account ${s.account} prüfen und wieder freigeben${s.reason ? ` (${s.reason})` : ""}` });

  const daysLeft = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate() - now.getUTCDate();
  return {
    month, currency: "USD", eur_rate: EUR_RATE,
    totals: { revenue: Math.round(rev?.s ?? 0), costs, pending, week_delta: Math.round(revWeek?.s ?? 0) },
    history, campaigns, accounts, insights, tasks, goal_monthly: GOAL_MONTHLY,
    meta: { generated_at: now.toISOString(), days_left: daysLeft, posts_posted: postedAll.length, posts_scheduled: posts.filter((p) => p.status === "scheduled").length,
            views_source: withViews.length ? "posts.views_*" : "none (Blotato liefert keine Views)" },
  };
}
