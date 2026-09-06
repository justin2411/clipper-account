// Wochenbericht (Stufe 2): Kennzahlen einer Kalenderwoche (Mo–So, UTC) je Account und Art (paid/fan), Vergleich zur Vorwoche,
// Top-Posts, „Gelernt" und 3 Vorschläge (regelbasiert; der Chat-Nachtrag ersetzt sie später durch das starke Modell).
// Sonntags 09:00 Berlin: Bericht der laufenden Woche in kv (report:<YYYY-Www>) speichern + Telegram-Kurzfassung mit Link auf #report.
// GET /report?week=current|<YYYY-Www> (Dashboard-Key) liefert den Bericht; /dashboard trägt den zuletzt gespeicherten + die Wochenliste.
import { Env, db, nowIso, telegram, nichesOf, nicheOfAccount } from "./shared";
import { accountsOf } from "./publisher";
import { fanStock } from "./fan";

export interface ReportAccount {
  id: string; handle: string; niche: string; posts: number; live: number; shadow: number; views: number; avg_views: number; likes: number;
  followers: number | null; followers_delta: number | null; best: { url: string; views: number; hook: string } | null; under_200: number; paused: boolean;
}
export interface WeeklyReport {
  week: string; from: string; to: string; generated_at: string; partial: boolean;
  totals: { posts: number; live: number; shadow: number; views: number; avg_views: number; likes: number; followers_delta: number; payouts_usd: number; costs_usd: number;
            clips: number; clips_rejected: number; submitted: number; qualified_rate: number };
  prev: { posts: number; views: number; avg_views: number; payouts_usd: number; followers_delta: number } | null;
  by_kind: { kind: "paid" | "fan"; posts: number; views: number; avg_views: number; clips: number; rejected: number }[];
  accounts: ReportAccount[];
  top_posts: { url: string; account: string; views: number; likes: number; hook: string; kind: string; campaign: string; posted_at: string }[];
  learned: { best_slot: string; best_hook_type: string; best_font: string; best_account: string };
  suggestions: { text: string; action?: { kind: string; label: string; href?: string } }[];
  summary: string[];
}

const isoWeek = (d: Date): string => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7)).padStart(2, "0")}`;
};
/** Montag 00:00 UTC der Woche, die `d` enthält. */
const weekStart = (d: Date): Date => { const s = new Date(d); s.setUTCHours(0, 0, 0, 0); s.setUTCDate(s.getUTCDate() - ((s.getUTCDay() || 7) - 1)); return s; };
const parseWeek = (w: string): Date | null => {
  const m = /^(\d{4})-W(\d{2})$/.exec(w); if (!m) return null;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const s = weekStart(jan4); s.setUTCDate(s.getUTCDate() + (Number(m[2]) - 1) * 7); return s;
};
const r0 = (n: number) => Math.round(n || 0);

async function stats(env: Env, from: string, to: string, ws: string) {
  const posts = await db.all<any>(env,
    `SELECT p.id, p.status, p.mode, p.post_url, p.posted_at, p.scheduled_at, COALESCE(p.views, p.views_7d, p.views_72h, p.views_24h) AS views, COALESCE(p.likes,0) AS likes,
            COALESCE(p.kind, ca.kind, 'paid') AS kind, c.account, c.hook_type, c.hook, c.context_line, c.variant, ca.name AS camp_name, ca.min_views, ca.niche_id
     FROM posts p JOIN clips c ON c.id = p.clip_id LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE p.workspace_id = ? AND COALESCE(p.posted_at, p.scheduled_at) >= ? AND COALESCE(p.posted_at, p.scheduled_at) < ? AND p.status IN ('posted','shadow','submitted')`, ws, from, to);
  const clips = await db.all<any>(env,
    `SELECT COALESCE(ca.kind,'paid') AS kind, COUNT(*) AS n, SUM(CASE WHEN c.status LIKE 'rejected%' THEN 1 ELSE 0 END) AS rejected
     FROM clips c LEFT JOIN campaigns ca ON ca.id = c.campaign_id WHERE c.workspace_id = ? AND c.created_at >= ? AND c.created_at < ? GROUP BY 1`, ws, from, to);
  const pay = await db.first<any>(env, "SELECT COALESCE(SUM(amount_usd),0) AS s FROM payouts WHERE at >= ? AND at < ?", from, to);
  const cost = await db.first<any>(env, "SELECT COALESCE(SUM(amount_usd),0) AS s FROM costs WHERE at >= ? AND at < ?", from, to);
  const sub = await db.first<any>(env, "SELECT COUNT(*) AS n FROM posts WHERE workspace_id = ? AND submitted_at >= ? AND submitted_at < ?", ws, from, to);
  const fol = await db.all<any>(env,
    `SELECT account, MIN(day) AS d0, MAX(day) AS d1 FROM account_stats WHERE workspace_id = ? AND day >= ? AND day < ? GROUP BY account`, ws, from.slice(0, 10), to.slice(0, 10));
  const followers: Record<string, { first: number | null; last: number | null }> = {};
  for (const f of fol) {
    const a = await db.first<any>(env, "SELECT followers FROM account_stats WHERE account = ? AND day = ?", f.account, f.d0);
    const b = await db.first<any>(env, "SELECT followers FROM account_stats WHERE account = ? AND day = ?", f.account, f.d1);
    followers[f.account] = { first: a?.followers ?? null, last: b?.followers ?? null };
  }
  return { posts, clips, payouts: Number(pay?.s ?? 0), costs: Number(cost?.s ?? 0), submitted: Number(sub?.n ?? 0), followers };
}

export async function buildWeeklyReport(env: Env, week = "current", ws = "default"): Promise<WeeklyReport> {
  const now = new Date();
  const start = week === "current" ? weekStart(now) : (parseWeek(week) ?? weekStart(now));
  const end = new Date(start.getTime() + 7 * 86400000);
  const partial = end.getTime() > now.getTime();
  const from = start.toISOString(), to = end.toISOString();
  const cur = await stats(env, from, to, ws);
  const prevStart = new Date(start.getTime() - 7 * 86400000);
  const prev = await stats(env, prevStart.toISOString(), from, ws);
  const cfg = accountsOf(env);
  const state = await db.all<any>(env, "SELECT account, paused FROM account_state");
  const withViews = (ps: any[]) => ps.filter((p) => p.views != null);
  const sum = (ps: any[], k: string) => ps.reduce((a, p) => a + Number(p[k] ?? 0), 0);
  const avg = (ps: any[]) => (withViews(ps).length ? sum(withViews(ps), "views") / withViews(ps).length : 0);
  const live = cur.posts.filter((p) => p.mode !== "shadow" && p.status !== "shadow");

  const accounts: ReportAccount[] = Object.entries(cfg).map(([id, a]: [string, any]) => {
    const ps = cur.posts.filter((p) => p.account === id);
    const vp = withViews(ps).sort((x, y) => y.views - x.views);
    const f = cur.followers[id];
    return { id, handle: a.handle ?? id, niche: nicheOfAccount(env, id)?.key ?? nichesOf(env)[0]?.key ?? "mrbeast", posts: ps.length,
             live: ps.filter((p) => p.mode !== "shadow" && p.status !== "shadow").length, shadow: ps.filter((p) => p.mode === "shadow" || p.status === "shadow").length,
             views: sum(ps, "views"), avg_views: r0(avg(ps)), likes: sum(ps, "likes"), followers: f?.last ?? null,
             followers_delta: f && f.first != null && f.last != null ? f.last - f.first : null,
             best: vp[0]?.post_url ? { url: vp[0].post_url, views: vp[0].views, hook: vp[0].context_line ?? vp[0].hook ?? "" } : null,
             under_200: vp.filter((p) => p.views < 200).length, paused: !!state.find((s) => s.account === id)?.paused };
  });
  const byKind = (["paid", "fan"] as const).map((kind) => {
    const ps = cur.posts.filter((p) => p.kind === kind), cl = cur.clips.find((c) => c.kind === kind);
    return { kind, posts: ps.length, views: sum(ps, "views"), avg_views: r0(avg(ps)), clips: Number(cl?.n ?? 0), rejected: Number(cl?.rejected ?? 0) };
  });
  const top = withViews(cur.posts).filter((p) => p.post_url).sort((a, b) => b.views - a.views).slice(0, 5).map((p) => ({
    url: p.post_url, account: p.account, views: p.views, likes: p.likes, hook: p.context_line ?? p.hook ?? "", kind: p.kind, campaign: p.camp_name ?? "", posted_at: p.posted_at ?? p.scheduled_at }));
  const groupBest = (ps: any[], key: (p: any) => string) => {
    const m: Record<string, number[]> = {};
    for (const p of withViews(ps)) (m[key(p)] ??= []).push(p.views);
    return Object.entries(m).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length] as const).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "–";
  };
  const learned = {
    best_slot: groupBest(cur.posts, (p) => (p.posted_at ?? p.scheduled_at ?? "").slice(11, 16) + " UTC"),
    best_hook_type: ({ moment: "Moment-Clip", reaction: "Reaktions-Clip" } as any)[groupBest(cur.posts, (p) => p.hook_type ?? "–")] ?? groupBest(cur.posts, (p) => p.hook_type ?? "–"),
    best_font: groupBest(cur.posts, (p) => p.variant ?? "Standard"),
    best_account: groupBest(cur.posts, (p) => p.account),
  };
  const followersDelta = accounts.reduce((a, x) => a + (x.followers_delta ?? 0), 0);
  const prevFollowers = Object.values(prev.followers).reduce((a, f) => a + ((f.first != null && f.last != null) ? f.last - f.first : 0), 0);
  const qualified = live.length ? withViews(live).filter((p) => p.views >= (p.min_views ?? 0)).length / live.length : 0;
  const totals = { posts: cur.posts.length, live: live.length, shadow: cur.posts.length - live.length, views: sum(cur.posts, "views"), avg_views: r0(avg(cur.posts)),
                   likes: sum(cur.posts, "likes"), followers_delta: followersDelta, payouts_usd: r0(cur.payouts), costs_usd: Math.round(cur.costs * 100) / 100,
                   clips: cur.clips.reduce((a, c) => a + Number(c.n), 0), clips_rejected: cur.clips.reduce((a, c) => a + Number(c.rejected), 0), submitted: cur.submitted,
                   qualified_rate: Math.round(qualified * 100) / 100 };
  const prevT = { posts: prev.posts.length, views: sum(prev.posts, "views"), avg_views: r0(avg(prev.posts)), payouts_usd: r0(prev.payouts), followers_delta: prevFollowers };

  // Vorschläge (regelbasiert, max. 3) – bestätigbare Aktionen zeigen auf bestehende Seiten/Routen
  const suggestions: WeeklyReport["suggestions"] = [];
  try {
    const st = await fanStock(env), stockDays = Number(env.STOCK_DAYS || 3), seen = new Set<string>();
    for (const [acc, s] of Object.entries(st)) {
      const n = nicheOfAccount(env, acc); if (!n || seen.has(n.key)) continue;
      const days = s.target ? (s.ready * stockDays) / s.target : 0;
      if (days < 2) { seen.add(n.key); suggestions.push({ text: `Fan-Vorrat für ${n.label} reicht noch ${days.toFixed(1)} Tage – Video hochladen.`, action: { kind: "footage", label: "Nische öffnen", href: `#n:${n.key}` } }); }
    }
  } catch { /* fanStock optional */ }
  for (const a of accounts) {
    if (a.paused) suggestions.push({ text: `Account ${a.id} ist pausiert – prüfen und freigeben, sobald die Ursache geklärt ist.`, action: { kind: "resume", label: `Account ${a.id} freigeben`, href: "#tasks" } });
    else if (a.posts >= 5 && a.under_200 / Math.max(1, withViews(cur.posts.filter((p) => p.account === a.id)).length) > 0.6)
      suggestions.push({ text: `${a.id}: ${a.under_200} von ${a.posts} Posts unter 200 Views – Hook-Stil in der Feinjustierung ändern (Akzent, Größe, Animation).`, action: { kind: "settings", label: "Feinjustierung", href: "#settings" } });
  }
  if (learned.best_slot !== "–" && withViews(cur.posts).length >= 6) suggestions.push({ text: `Bester Slot diese Woche: ${learned.best_slot} – zweiten Slot in die Nähe legen.`, action: { kind: "settings", label: "Slots anpassen", href: "#settings" } });
  if (totals.submitted < live.filter((p) => p.kind === "paid").length) suggestions.push({ text: `${live.filter((p) => p.kind === "paid").length - totals.submitted} Paid-Posts noch nicht bei Vyro eingereicht.`, action: { kind: "submit", label: "Aufgaben", href: "#tasks" } });
  if (!suggestions.length) suggestions.push({ text: "Alles im Rahmen – nichts zu entscheiden." });

  const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)} %` : (a ? "neu" : "±0"));
  const summary = [
    `${totals.live} Posts live (${totals.shadow} Schatten), ${totals.views.toLocaleString("de-DE")} Views, Ø ${totals.avg_views} pro Post (${pct(totals.views, prevT.views)} zur Vorwoche).`,
    `${totals.followers_delta >= 0 ? "+" : ""}${totals.followers_delta} Follower, ${totals.payouts_usd} $ ausgezahlt, ${totals.clips} Clips produziert (${totals.clips_rejected} verworfen).`,
    `Bester Account: ${learned.best_account}${top[0]?.views ? ` · Top-Post ${top[0].views.toLocaleString("de-DE")} Views: „${top[0].hook}"` : " · noch keine Views-Daten"}.`,
  ];
  return { week: isoWeek(start), from, to, generated_at: nowIso(), partial, totals, prev: prev.posts.length || prev.payouts ? prevT : null, by_kind: byKind,
           accounts, top_posts: top, learned, suggestions: suggestions.slice(0, 3), summary };
}

export async function saveWeeklyReport(env: Env, rep: WeeklyReport, ws = "default") {
  await db.run(env, "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
               `report:${ws}:${rep.week}`, JSON.stringify(rep), nowIso());
  const old = await db.all<{ key: string }>(env, "SELECT key FROM kv WHERE key LIKE ? ORDER BY key DESC", `report:${ws}:%`);
  for (const k of old.slice(12)) await db.run(env, "DELETE FROM kv WHERE key = ?", k.key);
}

export async function listReports(env: Env, ws = "default"): Promise<{ week: string; generated_at: string; posts: number; views: number; payouts_usd: number }[]> {
  const rows = await db.all<{ key: string; value: string }>(env, "SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key DESC LIMIT 12", `report:${ws}:%`);
  return rows.map((r) => { const v = JSON.parse(r.value) as WeeklyReport; return { week: v.week, generated_at: v.generated_at, posts: v.totals.posts, views: v.totals.views, payouts_usd: v.totals.payouts_usd }; });
}

export async function getReport(env: Env, week = "latest", ws = "default"): Promise<WeeklyReport | null> {
  if (week === "current") return buildWeeklyReport(env, "current", ws);
  const row = week === "latest"
    ? await db.first<{ value: string }>(env, "SELECT value FROM kv WHERE key LIKE ? ORDER BY key DESC LIMIT 1", `report:${ws}:%`)
    : await db.first<{ value: string }>(env, "SELECT value FROM kv WHERE key = ?", `report:${ws}:${week}`);
  if (row) return JSON.parse(row.value);
  return week === "latest" ? null : buildWeeklyReport(env, week, ws);
}

/** Cron sonntags 07:00 UTC (09:00 Berlin Sommerzeit, 08:00 Winterzeit; Cloudflare-Cron kennt keine Zeitzonen). force = manuell. */
export async function runWeeklyReport(env: Env, force = false) {
  if (!force && new Date().getUTCDay() !== 0) return { skipped: "nicht Sonntag" };
  const rep = await buildWeeklyReport(env, "current");
  await saveWeeklyReport(env, rep);
  const dash = env.DASHBOARD_URL || "https://clipforge-dashboard-bh8.pages.dev";
  const L = [`📊 Wochenbericht ${rep.week}`, ...rep.summary, "", "Vorschläge:", ...rep.suggestions.map((s, i) => `${i + 1}. ${s.text}`), "", `Details: ${dash}/#report`];
  await telegram(env, L.join("\n"));
  return { week: rep.week, posts: rep.totals.posts, views: rep.totals.views };
}
