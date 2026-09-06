// Auszahlungen & Abgleich (Nachtrag 5): Zahlungen (Vyro/Whop) → Kampagne → Clips.
// Je Kampagne: erwartet (Views × Rate je 1000, gedeckelt durch max_per_post_usd, unter min_views zählt ein Post nicht) gegen tatsächlich
// ausgezahlt; Proration sichtbar (ausgezahlt ÷ erwartet), Kosten je Clip (Blotato anteilig + LLM je Clip + gebuchte Kosten), Marge je Kampagne.
// CSV-Export über ?csv=1 (Kampagnen) bzw. ?csv=posts (Posts einzeln).
import { Env, db } from "./shared";

const BLOTATO_FIXED_USD = 29, LLM_PER_CLIP_USD = 0.01;
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function buildPayouts(env: Env, days = 90, ws = "default") {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const posts = await db.all<any>(env,
    `SELECT p.id, p.status, p.posted_at, p.submitted_at, p.post_url, COALESCE(p.views, p.views_7d, p.views_72h, p.views_24h) AS views,
            c.account, c.campaign_id, c.hook, c.context_line, ca.name AS campaign, ca.platform, ca.kind, ca.rate_per_1k_usd, ca.min_views, ca.max_per_post_usd, ca.niche_id
     FROM posts p JOIN clips c ON c.id = p.clip_id JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE p.workspace_id = ? AND p.status IN ('posted','submitted') AND p.posted_at >= ?`, ws, since);
  const payouts = await db.all<any>(env, "SELECT id, campaign_id, amount_usd, source, at FROM payouts WHERE workspace_id = ? AND at >= ? ORDER BY at DESC", ws, since);
  const clipCounts = await db.all<any>(env, "SELECT campaign_id, COUNT(*) AS n FROM clips WHERE workspace_id = ? AND created_at >= ? GROUP BY campaign_id", ws, since);
  const costRows = await db.all<any>(env, "SELECT campaign_id, kind, SUM(amount_usd) AS s FROM costs WHERE COALESCE(workspace_id,'default') = ? AND at >= ? GROUP BY campaign_id, kind", ws, since).catch(() => [] as any[]);
  const camps = await db.all<any>(env, "SELECT id, name, platform, kind, status, rate_per_1k_usd, min_views, max_per_post_usd, budget_total_usd, budget_used_usd, external_url, niche_id, created_at FROM campaigns WHERE workspace_id = ? ORDER BY created_at DESC", ws);

  const clipsTotal = clipCounts.reduce((a, c) => a + Number(c.n), 0) || 1;
  // Blotato zeitanteilig: nur die Tage, an denen im Fenster tatsächlich produziert wurde (erster Clip → heute), nicht das ganze Fenster
  const firstClip = await db.first<{ t: string | null }>(env, "SELECT MIN(created_at) AS t FROM clips WHERE workspace_id = ? AND created_at >= ?", ws, since);
  const activeDays = firstClip?.t ? Math.max(1, (Date.now() - new Date(firstClip.t).getTime()) / 86400000) : 0;
  const blotatoTotal = BLOTATO_FIXED_USD * (Math.min(activeDays, days) / 30);
  const expectedOf = (p: any) => {
    const v = Number(p.views ?? 0), rate = Number(p.rate_per_1k_usd ?? 0);
    if (!rate) return 0;
    if (v < Number(p.min_views ?? 0)) return 0;
    return Math.min((v / 1000) * rate, Number(p.max_per_post_usd ?? Infinity));
  };
  const rows = camps.map((c) => {
    const ps = posts.filter((p) => p.campaign_id === c.id);
    const expected = ps.reduce((a, p) => a + expectedOf(p), 0);
    const paid = payouts.filter((p) => p.campaign_id === c.id).reduce((a, p) => a + Number(p.amount_usd ?? 0), 0);
    const clips = Number(clipCounts.find((x) => x.campaign_id === c.id)?.n ?? 0);
    const booked = costRows.filter((x) => x.campaign_id === c.id).reduce((a, x) => a + Number(x.s ?? 0), 0);
    const cost = booked + clips * LLM_PER_CLIP_USD + (clips / clipsTotal) * blotatoTotal;      // Blotato anteilig nach Clip-Anzahl
    const withViews = ps.filter((p) => p.views != null && Number(p.views) > 0);
    return {
      id: c.id, name: c.name, platform: c.platform, kind: c.kind ?? "paid", status: c.status, niche: c.niche_id, url: c.external_url,
      rate_per_1k: c.rate_per_1k_usd ?? 0, min_views: c.min_views ?? 0, max_per_post: c.max_per_post_usd ?? null,
      posts: ps.length, posts_with_views: withViews.length, submitted: ps.filter((p) => p.submitted_at).length, views: ps.reduce((a, p) => a + Number(p.views ?? 0), 0),
      clips, expected_usd: r2(expected), paid_usd: r2(paid), open_usd: r2(Math.max(0, expected - paid)),
      proration_pct: expected > 0 ? Math.round((paid / expected) * 100) : null,
      cost_usd: r2(cost), cost_per_clip_usd: clips ? r2(cost / clips) : null, margin_usd: r2(paid - cost),
      margin_pct: paid > 0 ? Math.round(((paid - cost) / paid) * 100) : null,
      payouts: payouts.filter((p) => p.campaign_id === c.id).map((p) => ({ id: p.id, amount_usd: r2(Number(p.amount_usd ?? 0)), source: p.source, at: p.at })),
    };
  }).filter((r) => r.posts || r.clips || r.paid_usd);

  const unassigned = payouts.filter((p) => !p.campaign_id || !camps.some((c) => c.id === p.campaign_id));
  const totals = {
    expected_usd: r2(rows.reduce((a, r) => a + r.expected_usd, 0)),
    paid_usd: r2(payouts.reduce((a, p) => a + Number(p.amount_usd ?? 0), 0)),
    open_usd: r2(rows.reduce((a, r) => a + r.open_usd, 0)),
    cost_usd: r2(rows.reduce((a, r) => a + r.cost_usd, 0)),
    margin_usd: r2(payouts.reduce((a, p) => a + Number(p.amount_usd ?? 0), 0) - rows.reduce((a, r) => a + r.cost_usd, 0)),
    clips: rows.reduce((a, r) => a + r.clips, 0), posts: rows.reduce((a, r) => a + r.posts, 0),
    cost_per_clip_usd: rows.reduce((a, r) => a + r.clips, 0) ? r2(rows.reduce((a, r) => a + r.cost_usd, 0) / rows.reduce((a, r) => a + r.clips, 0)) : null,
    month_paid_usd: r2(payouts.filter((p) => p.at >= monthStart).reduce((a, p) => a + Number(p.amount_usd ?? 0), 0)),
    unassigned_usd: r2(unassigned.reduce((a, p) => a + Number(p.amount_usd ?? 0), 0)),
  };
  const postRows = posts.map((p) => ({ id: p.id, at: p.posted_at, account: p.account, campaign: p.campaign, campaign_id: p.campaign_id, kind: p.kind ?? "paid",
    hook: p.context_line ?? p.hook ?? "", views: p.views ?? null, expected_usd: r2(expectedOf(p)), submitted: !!p.submitted_at, url: p.post_url }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { days, since, blotato_days: Math.round(Math.min(activeDays, days) * 10) / 10, totals, campaigns: rows, posts: postRows.slice(0, 300), payouts: payouts.map((p) => ({ ...p, amount_usd: r2(Number(p.amount_usd ?? 0)) })), unassigned,
           note: postRows.some((p) => p.views == null || Number(p.views) === 0) ? "Für einen Teil der Posts liegen noch keine Views vor (Blotato-Analytics verzögert) – erwartete Beträge sind Untergrenzen." : null };
}

export function payoutsCsv(data: any, which: "campaigns" | "posts"): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  if (which === "posts") {
    const head = ["zeit", "account", "kampagne", "art", "hook", "views", "erwartet_usd", "eingereicht", "url"];
    return [head.join(";"), ...data.posts.map((p: any) => [p.at, p.account, p.campaign, p.kind, p.hook, p.views ?? "", p.expected_usd, p.submitted ? "ja" : "nein", p.url ?? ""].map(esc).join(";"))].join("\n");
  }
  const head = ["kampagne", "plattform", "art", "status", "rate_je_1k_usd", "posts", "views", "clips", "erwartet_usd", "ausgezahlt_usd", "offen_usd", "proration_pct", "kosten_usd", "kosten_je_clip_usd", "marge_usd", "marge_pct"];
  return [head.join(";"), ...data.campaigns.map((c: any) => [c.name, c.platform, c.kind, c.status, c.rate_per_1k, c.posts, c.views, c.clips, c.expected_usd, c.paid_usd, c.open_usd, c.proration_pct ?? "", c.cost_usd, c.cost_per_clip_usd ?? "", c.margin_usd, c.margin_pct ?? ""].map(esc).join(";"))].join("\n");
}
