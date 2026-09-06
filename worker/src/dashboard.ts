// GET /dashboard – Datenvertrag aus dashboard/index.html (Kommentar am Dateianfang).
// Views kommen erst, wenn eine Views-Quelle angebunden ist (Blotato liefert keine) → views/qualified/earned
// rechnen mit dem jeweils neuesten vorhandenen Wert (views_7d → views_72h → views_24h), sonst 0.
import { Env, db, nichesOf, tiktokProfileCached } from "./shared";
import { jobProgress } from "./progress";
import { accountsOf } from "./publisher";
import { getSettings, listVersions } from "./settings";
import { listTasks, syncTasks } from "./tasks";
import { listReview } from "./review";
import { getReport, listReports } from "./report";
import { abStats, AB_VARIABLES } from "./ab";
import { listLog, LOG_CATS } from "./log";
import { onboardingStatus } from "./onboarding";
import { suggestionLists } from "./catalog";
import { probeStatus } from "./probe";
import { accountHealth } from "./health";
import { listInbox, getRules } from "./inbox";
import { chatBudget } from "./chat";
import { buildCalendar } from "./calendar";
import { buildPayouts } from "./payouts";
import { listLibrary } from "./library";
import { lastAnomalies } from "./insights";

const BLOTATO_FIXED_USD = 29, LLM_PER_CLIP_USD = 0.01, EUR_RATE = 0.92, GOAL_MONTHLY = 2000;
const NICHE: Record<string, string> = { moments: "Momente", reactions: "Reaktionen" };

const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t.getTime() - y0.getTime()) / 86400000) + 1) / 7);
};

export async function buildDashboard(env: Env, ws = "default") {
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const monthStart = `${month}-01`;
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();

  // Umsatz = Auszahlungen (Scout liest Payout-Mails / manuell)
  const rev = await db.first<{ s: number }>(env, "SELECT COALESCE(SUM(amount_usd),0) AS s FROM payouts WHERE workspace_id = ? AND at >= ?", ws, monthStart);
  const revWeek = await db.first<{ s: number }>(env, "SELECT COALESCE(SUM(amount_usd),0) AS s FROM payouts WHERE workspace_id = ? AND at >= ?", ws, weekAgo);
  const clipsMonth = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM clips WHERE workspace_id = ? AND created_at >= ? AND status NOT IN ('rejected_precheck')", ws, monthStart);
  const costsTable = await db.first<{ s: number }>(env, "SELECT COALESCE(SUM(amount_usd),0) AS s FROM costs WHERE COALESCE(workspace_id, 'default') = ? AND at >= ?", ws, monthStart);
  const costs = Math.round((BLOTATO_FIXED_USD + LLM_PER_CLIP_USD * (clipsMonth?.n ?? 0) + (costsTable?.s ?? 0)) * 100) / 100;

  // Posts mit neuestem Views-Stand
  const posts = await db.all<any>(env,
    `SELECT p.id, p.status, p.post_url, p.posted_at, p.submitted_at, p.scheduled_at,
            COALESCE(p.views_7d, p.views_72h, p.views_24h) AS views,
            c.campaign_id, c.account, c.hook_type, ca.name AS camp_name, ca.rate_per_1k_usd, ca.min_views, ca.max_per_post_usd
     FROM posts p JOIN clips c ON c.id = p.clip_id JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE p.workspace_id = ? AND p.status IN ('scheduled','posted')`, ws);
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
    const r = await db.first<{ s: number }>(env, "SELECT COALESCE(SUM(amount_usd),0) AS s FROM payouts WHERE workspace_id = ? AND at >= ? AND at < ?", ws, start.toISOString(), end.toISOString());
    history.push({ week: `KW${isoWeek(start)}`, revenue: Math.round(r?.s ?? 0) });
  }

  // Kampagnen
  const allCamps = await db.all<any>(env, "SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY created_at DESC", ws);
  const campRows = allCamps.filter((c) => c.kind !== "fan");
  const fanIds = new Set(allCamps.filter((c) => c.kind === "fan").map((c) => c.id));
  const clipCounts = await db.all<{ campaign_id: string; n: number }>(env, "SELECT campaign_id, COUNT(*) AS n FROM clips WHERE workspace_id = ? AND status NOT IN ('rejected_precheck','rejected_review','test_private') GROUP BY campaign_id", ws);
  const campaigns: any[] = campRows.map((c) => {
    const ps = posts.filter((p) => p.campaign_id === c.id && p.status === "posted");
    const views = ps.reduce((a, p) => a + (p.views ?? 0), 0);
    const qualified = ps.filter((p) => (p.views ?? 0) >= (c.min_views ?? 0) && (p.views ?? 0) > 0).length;
    const earned = Math.round(ps.reduce((a, p) => a + earnedOf(p), 0));
    const total = c.budget_total_usd ?? 0, used = c.budget_used_usd ?? 0;
    return { id: c.id, name: c.name, platform: c.platform, kind: "paid", niche: c.niche_id ?? "mrbeast", status: c.status === "draft" ? "joined" : c.status,
      rate_per_1k: c.rate_per_1k_usd ?? 0, clips: clipCounts.find((x) => x.campaign_id === c.id)?.n ?? 0,
      views, qualified, earned, budget_used: used, budget_total: total, paid_out_pct: total ? Math.round((used / total) * 100) : null };
  });
  if (fanIds.size) {                                   // Fan-Content als eine Sammelzeile (viele fan-<video>-Kampagnen)
    const ps = posts.filter((p) => fanIds.has(p.campaign_id) && p.status === "posted");
    const vids = await db.first<any>(env, "SELECT SUM(status='clipped') AS c, SUM(status='new') AS n FROM videos WHERE workspace_id = ?", ws);
    campaigns.push({ id: "fan", name: "Fan-Content", platform: "upload", kind: "fan", niche: "mrbeast", status: "active", rate_per_1k: 0,
      clips: clipCounts.filter((x) => fanIds.has(x.campaign_id)).reduce((a, x) => a + x.n, 0),
      views: ps.reduce((a, p) => a + (p.views ?? 0), 0), qualified: 0, earned: 0, budget_used: vids?.c ?? 0, budget_total: (vids?.c ?? 0) + (vids?.n ?? 0), paid_out_pct: null });
  }

  // Accounts (Views/Likes aus Blotato-Post-Analytics via account_stats; Follower liefert Blotato nicht → 0, followers_7d 0)
  const state = await db.all<any>(env, "SELECT * FROM account_state WHERE workspace_id = ?", ws);
  const cfg = accountsOf(env) as Record<string, any>;
  const nichesCfg = nichesOf(env);
  const todayStat = await db.all<any>(env, "SELECT s.* FROM account_stats s WHERE s.workspace_id = ? AND s.day = (SELECT MAX(day) FROM account_stats WHERE account = s.account AND workspace_id = s.workspace_id)", ws);
  const weekAgoStat = await db.all<any>(env, "SELECT s.* FROM account_stats s WHERE s.workspace_id = ? AND s.day = (SELECT MAX(day) FROM account_stats WHERE account = s.account AND workspace_id = s.workspace_id AND day <= ?)", ws, new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10));
  const accounts = [] as any[];
  for (const [id, a] of Object.entries(cfg)) {
    const st = state.find((s) => s.account === id);
    const ps = posts.filter((p) => p.account === id && p.status === "posted" && p.views != null);
    const t = todayStat.find((x) => x.account === id), w = weekAgoStat.find((x) => x.account === id);
    const withMetrics = ps.some((p) => Number(p.views) > 0) || Number(t?.views_7d ?? 0) > 0;   // Blotato liefert erst Zahlen, wenn es sie abgeholt hat
    const avg = ps.length ? Math.round(ps.reduce((x, p) => x + p.views, 0) / ps.length) : 0;
    const earned30 = Math.round(posts.filter((p) => p.account === id && p.status === "posted" && p.posted_at >= new Date(now.getTime() - 30 * 86400000).toISOString()).reduce((x, p) => x + earnedOf(p), 0));
    const handle = String(a.handle ?? "");
    const niche = a.niche ?? nichesCfg.find((n) => n.accounts.includes(id))?.key ?? "";
    const live = handle ? await tiktokProfileCached(env, handle) : null;              // Follower/Likes live von der TikTok-Profilseite (5-min-Cache)
    const health = await accountHealth(env, id, ws).catch(() => null);                 // Nachtrag 1: Ampel
    const followers = live?.followers ?? t?.followers ?? 0;
    accounts.push({ id, handle, niche, platform: "tiktok", url: handle ? `https://www.tiktok.com/${handle.startsWith("@") ? handle : "@" + handle}` : "",
      followers, followers_7d: Math.max(0, followers - (w?.followers ?? followers)), likes_total: live?.likes_total ?? t?.likes_total ?? 0, videos: live?.videos ?? t?.videos ?? null,
      views_7d: withMetrics ? (t?.views_7d ?? 0) : null, views_30d: withMetrics ? (t?.views_30d ?? 0) : null, earnings_30d: earned30, avg_views: withMetrics ? avg : null, posts_7d: t?.posts_7d ?? 0,
      metrics: withMetrics ? "ok" : "pending",                                        // pending = Blotato hat noch nie Views geliefert
      paused: !!st?.paused, reason: st?.reason ?? null, niche_label: NICHE[a.niche ?? a.style ?? ""] ?? (a.niche ?? a.style ?? ""), live: !!live, health });
  }
  const niches = nichesCfg.map((n) => ({ key: n.key, label: n.label, color: n.color, accounts: n.accounts }));

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

  // Aufgaben (tasks.ts: automatisch angelegt/abgehakt), Review-Clips, Einstellungen
  try { await syncTasks(env, ws); } catch (e: any) { console.log("[dashboard] syncTasks", e?.message ?? e); }
  const taskList = await listTasks(env, ws);
  const tasks = taskList.map((t) => ({ ...t, type: t.kind, text: t.title, url: t.campaign_url ?? undefined }));   // type/text/url: Kompatibilität v1
  const review = await listReview(env, ws);
  const settings = await getSettings(env, ws);
  const settings_versions = await listVersions(env, ws);   // Stufe 3: letzte 10 Stände fürs Zurücksetzen

  const daysLeft = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate() - now.getUTCDate();
  const pipeline = await buildPipeline(env, ws);
  const postList = (await db.all<any>(env,
    `SELECT p.id, p.post_url, p.posted_at, p.views, p.likes, c.account, c.caption, c.thumb_url, c.cover_url, c.campaign_id, ca.kind, ca.niche_id, ca.name AS camp_name
     FROM posts p JOIN clips c ON c.id = p.clip_id JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE p.workspace_id = ? AND p.status = 'posted' AND p.post_url IS NOT NULL ORDER BY p.posted_at DESC LIMIT 120`, ws)).map((p) => ({
    id: p.id, account: p.account, niche: p.niche_id ?? cfg[p.account]?.niche ?? "mrbeast", url: p.post_url, thumb: p.cover_url ?? p.thumb_url ?? null,
    caption: String(p.caption ?? "").split("\n")[0], posted_at: p.posted_at, views: p.views ?? 0, likes: p.likes ?? 0, type: p.kind ?? "paid", campaign: p.camp_name }));
  const sources = await buildSources(env, allCamps, cfg, ws);
  const report = { latest: await getReport(env, "latest", ws), weeks: await listReports(env, ws) };   // Stufe 2: zuletzt gespeicherter Wochenbericht + Wochenliste
  const ab = { ...(await abStats(env, ws)), variables: AB_VARIABLES };                                // Stufe 4: A/B-Test
  const log = { ...(await listLog(env, { cat: "all", limit: 60 }, ws)), cats: LOG_CATS };            // Stufe 5: Ereignis-Log (erste Seite)
  const onboarding = await onboardingStatus(env, ws);                                                  // Stufe 6: Checkliste beim ersten Start
  const inbox = { ...(await listInbox(env, { filter: "open", limit: 30 }, ws)), rules: await getRules(env, ws) };   // Nachtrag 2
  const chat = { enabled: !!env.ANTHROPIC_API_KEY, budget: await chatBudget(env, ws) };                              // Nachtrag 3
  const calendar = await buildCalendar(env, 0, ws);                                                                   // Nachtrag 4: laufende Woche
  const payouts = await buildPayouts(env, 90, ws);                                                                    // Nachtrag 5
  const library = await listLibrary(env, { limit: 24 }, ws);                                                          // Nachtrag 6: erste Seite
  const anomalies = await lastAnomalies(env, ws);                                                                     // Nachtrag 7: letzter Anomalie-Check
  // Vorschläge je Nische: zwei Listen (frisch < 14 Tage, Archiv > 6 Monate nach Aufrufen × Bewertung) plus die alte flache Liste
  const suggestions: Record<string, any> = {};
  for (const n of nichesCfg) {
    try {
      const lists = await suggestionLists(env, n.key, ws, 8);
      suggestions[n.key] = { ...lists, items: [...lists.archive, ...lists.fresh] };
    } catch { suggestions[n.key] = { fresh: [], archive: [], items: [], blocked: 0, unrated: 0 }; }
  }
  return {
    pipeline, niches, sources, posts: postList, review, settings, settings_versions, report, ab, log, onboarding, suggestions, inbox, chat, calendar, payouts, library, anomalies,
    probe: await probeStatus(env, ws).catch(() => null),
    month, currency: "USD", eur_rate: EUR_RATE,
    totals: { revenue: Math.round(rev?.s ?? 0), costs, pending, week_delta: Math.round(revWeek?.s ?? 0) },
    history, campaigns, accounts, insights, tasks, goal_monthly: GOAL_MONTHLY,
    meta: { workspace: ws, generated_at: now.toISOString(), days_left: daysLeft, posts_posted: postedAll.length, posts_scheduled: posts.filter((p) => p.status === "scheduled").length,
            views_source: withViews.length ? "posts.views_*" : "none (Blotato liefert keine Views)" },
  };
}

// ---------- Pipeline-Live-Ansicht (Stufen, laufende GitHub-Actions-Jobs, Queue, letzte Events) ----------
type Stage = { key: string; label: string; status: "idle" | "running" | "ok" | "error"; last_run?: string; info: string };
const STEP_PROGRESS: Record<string, [number, string]> = {
  "Set up job": [0.02, "Runner startet"], "Run actions/checkout@v4": [0.04, "Checkout"], "preflight": [0.06, "Preflight"],
  "Run actions/setup-python@v5": [0.08, "Python"], "cache whisper/hf models": [0.1, "Modell-Cache"],
  "system packages": [0.14, "ffmpeg installieren"], "pip install": [0.22, "Abhängigkeiten installieren"],
  "clip pipeline": [0.35, "Download · Whisper · Gemini · Schnitt"], "Run actions/upload-artifact@v4": [0.97, "Artefakt hochladen"],
};
const tmUtc = (iso?: string | null) => iso ? new Date(iso).toISOString().slice(11, 16) + " UTC" : "–";
const agoMin = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));

async function githubJobs(env: Env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return [] as any[];
  const h = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "clipforge-worker" };
  const jobs: any[] = [];
  try {
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/clip.yml/runs?per_page=6`, { headers: h });
    if (!r.ok) return jobs;
    const runs = ((await r.json()) as any).workflow_runs ?? [];
    for (const run of runs.filter((x: any) => x.status === "queued" || x.status === "in_progress" || x.status === "waiting")) {
      let step = "", progress = 0.02;
      try {
        const jr = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${run.id}/jobs`, { headers: h });
        const steps: any[] = ((await jr.json()) as any).jobs?.[0]?.steps ?? [];
        const cur = steps.find((s) => s.status === "in_progress") ?? [...steps].reverse().find((s) => s.status === "completed");
        if (cur) { const p = STEP_PROGRESS[cur.name]; progress = p?.[0] ?? 0.5; step = p?.[1] ?? cur.name; }
      } catch {}
      jobs.push({ id: `run-${run.run_number}`, run_id: run.id, label: `Clip-Job #${run.run_number}`, started: run.run_started_at ?? run.created_at,
                  progress, step, url: run.html_url });
    }
  } catch {}
  return jobs;
}

const parseEv = (e: string) => Object.fromEntries([...e.matchAll(/(\w+)=([^\s]+)/g)].map((m) => [m[1], m[2]]));

export async function buildPipeline(env: Env, ws = "default") {
  const now = Date.now();
  const ev = await db.all<{ id: number; campaign_id: string | null; event: string; at: string }>(env, "SELECT * FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT 200", ws);
  const camps = await db.all<{ id: string; name: string }>(env, "SELECT id, name FROM campaigns WHERE workspace_id = ?", ws);
  const nameOf = (id: string | null) => camps.find((c) => c.id === id)?.name ?? id ?? "";
  const last = (pred: (e: string) => boolean) => ev.find((x) => pred(x.event));
  const cronOf = (fn: string) => last((e) => e.startsWith(`cron ${fn} `));
  const cronStage = (key: string, label: string, everyMin: number, info: (e: string, at: string) => string): Stage => {
    const e = cronOf(key);
    if (!e) return { key, label, status: "idle", info: "noch kein Lauf" };
    const err = e.event.includes(" error ");
    const stale = agoMin(e.at) > everyMin * 3;
    return { key, label, status: err ? "error" : stale ? "idle" : "ok", last_run: e.at,
             info: err ? `Fehler ${tmUtc(e.at)}: ${e.event.split(" error ")[1]?.slice(0, 60)}` : info(e.event, e.at) };
  };

  // Clip-Jobs: dispatch → footage_ok → clipper_done → pipeline_done / clipper_error / footage_missing
  const jobs = await githubJobs(env);
  const dispatches = ev.filter((x) => /^clip_jobs?_dispatched/.test(x.event)).slice(0, 8);
  const used = new Set<number>();
  for (const j of jobs) {                                   // Label mit Kampagne/Account: zeitlich nächstes, noch nicht zugeordnetes Dispatch-Event
    const t = new Date(j.started).getTime();
    const d = dispatches.filter((x) => !used.has(x.id) && Math.abs(new Date(x.at).getTime() - t) < 10 * 60000)
                        .sort((a, b) => Math.abs(new Date(a.at).getTime() - t) - Math.abs(new Date(b.at).getTime() - t))[0];
    if (d) { used.add(d.id); const acc = parseEv(d.event).account; j.label = `Clip-Job · ${nameOf(d.campaign_id)}${acc ? ` · Account ${acc}` : ""}`; }
    const acc = (j.label.match(/Account (\w)/) ?? [])[1];
    const prog = ev.find((x) => new Date(x.at).getTime() >= new Date(j.started).getTime() - 60000 && /^(footage_ok|clipper_done|clipper_error)/.test(x.event) && (!acc || x.event.includes(`account=${acc}`)));
    if (prog && j.progress < 0.9) {
      if (prog.event.startsWith("clipper_done")) { j.progress = Math.max(j.progress, 0.8); j.step = `Schnitt fertig (${parseEv(prog.event).raw ?? "?"} Clips) · Overlay, Checks, Upload`; }
      else if (prog.event.startsWith("footage_ok")) { j.progress = Math.max(j.progress, 0.45); j.step = `Footage geladen (${Math.round(Number(parseEv(prog.event).bytes ?? 0) / 1048576)} MB) · Whisper, Gemini, Schnitt`; }
    }
  }
  const lastPipe = last((e) => /^(pipeline_done|clipper_error|footage_missing)/.test(e));
  const clipStage: Stage = jobs.length
    ? { key: "clip", label: "Clip-Job", status: "running",
        info: `${jobs.length} Job${jobs.length > 1 ? "s" : ""} (Account ${[...new Set(jobs.map((j) => (j.label.match(/Account (\w)/) ?? [])[1] ?? "?"))].sort().join(", ")}) · ${nameOf(dispatches[0]?.campaign_id ?? null)}` }
    : lastPipe
      ? { key: "clip", label: "Clip-Job", status: lastPipe.event.startsWith("pipeline_done") ? "ok" : "error", last_run: lastPipe.at,
          info: lastPipe.event.startsWith("pipeline_done")
            ? `${tmUtc(lastPipe.at)} · ${nameOf(lastPipe.campaign_id)} · ${parseEv(lastPipe.event).kept ?? ""} Clips`
            : `${tmUtc(lastPipe.at)} · ${lastPipe.event.slice(0, 70)}` }
      : { key: "clip", label: "Clip-Job", status: "idle", info: "noch kein Lauf" };

  // Footage: pro aktiver Kampagne der letzte footage_ok/-missing
  const active = await db.all<any>(env, "SELECT id, name, footage FROM campaigns WHERE workspace_id = ? AND status='active'", ws);
  const footBad = active.filter((c) => { const e = ev.find((x) => x.campaign_id === c.id && /^footage_/.test(x.event)); return e && e.event.startsWith("footage_missing"); });
  const footageStage: Stage = { key: "footage", label: "Footage", status: footBad.length ? "error" : active.length ? "ok" : "idle",
    info: footBad.length ? `Footage fehlt: ${footBad.map((c) => c.name).join(", ")}` : `${active.length} Kampagne${active.length === 1 ? "" : "n"} aktiv` };

  // Queue
  const q = await db.first<any>(env,
    `SELECT SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN status IN ('scheduled','shadow') THEN 1 ELSE 0 END) AS scheduled FROM clips WHERE workspace_id = ?`, ws);
  const today = new Date().toISOString().slice(0, 10);
  const pt = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM posts WHERE workspace_id = ? AND status='posted' AND substr(posted_at,1,10)=?", ws, today);
  const ps = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM posts WHERE workspace_id = ? AND status='posted' AND submitted_at IS NULL AND post_url IS NOT NULL", ws);
  const nextSlot = await db.first<{ t: string }>(env, "SELECT MIN(scheduled_at) AS t FROM posts WHERE workspace_id = ? AND status IN ('scheduled','shadow') AND scheduled_at > ?", ws, new Date().toISOString());
  const paused = await db.all<any>(env, "SELECT account FROM account_state WHERE workspace_id = ? AND paused=1", ws);

  const stages: Stage[] = [
    cronStage("scout", "Scout", 10, (e, at) => { const m = e.match(/"(new|created|campaigns)":(\d+)/); return `letzte Prüfung ${tmUtc(at)}${m ? ` · ${m[2]} neue` : ""}`; }),
    footageStage,
    clipStage,
    (() => { const s = cronStage("publisher", "Publisher", 30, (_e, at) => `letzter Lauf ${tmUtc(at)}`);
             const extra = paused.length ? `pausiert: ${paused.map((p) => p.account).join(", ")}` : nextSlot?.t ? `nächster Slot ${tmUtc(nextSlot.t)}` : "kein Slot geplant";
             const mode = (env.PUBLISH_MODE ?? "live").toLowerCase();
             return { ...s, info: `${mode === "shadow" ? "SCHATTEN · " : ""}${extra} · ${q?.ready ?? 0} bereit` }; })(),
    (() => { const s = cronStage("tracker", "Tracker", 360, (e, at) => { const m = e.match(/"(updated|live|posted)":(\d+)/); return `vor ${Math.round(agoMin(at) / 60)} h${m ? ` · ${m[2]} Posts aktualisiert` : ""}`; }); return s; })(),
  ];

  // Ereignis-Feed (deutsch, kurz)
  const nice = (x: { event: string; campaign_id: string | null }) => {
    const e = x.event, p = parseEv(e), c = nameOf(x.campaign_id);
    if (e.startsWith("clip_job")) return `Clip-Job gestartet · ${c}${p.account ? ` · ${p.account}` : ""}`;
    if (e.startsWith("footage_ok")) return `Footage geladen (${Math.round(Number(p.bytes ?? 0) / 1048576)} MB) · ${c} · ${p.account ?? ""}`;
    if (e.startsWith("footage_missing")) return `Footage fehlt · ${c}`;
    if (e.startsWith("clipper_done")) return `Schnitt fertig: ${p.raw ?? "?"} Rohclips · ${c} · ${p.account ?? ""}`;
    if (e.startsWith("clipper_error")) return `Schnitt-Fehler · ${c} · ${p.account ?? ""}: ${(e.split("err=")[1] ?? "").slice(0, 60)}`;
    if (e.startsWith("pipeline_done")) return `Clip-Job fertig: ${p.kept ?? "?"} Clips bereit · ${c} · ${p.account ?? ""}`;
    if (e.startsWith("publisher")) return p.mode === "shadow" ? `Publisher (Schatten): ${p.shadow ?? 0} Slots geplant` : `Publisher: ${p.scheduled ?? 0} Clips eingeplant`;
    if (e.startsWith("publish_now")) return `Sofort veröffentlicht · ${c} · ${p.account ?? ""}`;
    if (e.startsWith("vyro_submitted")) return `Bei Vyro eingereicht (${p.post ?? ""})`;
    if (e.startsWith("vyro_submit_failed")) return `Vyro-Einreichung fehlgeschlagen`;
    if (e.startsWith("go_live")) return `Freigabe: Publisher wieder aktiv`;
    if (e.startsWith("account_rules")) return `Account-Regel: ${e.replace("account_rules ", "").slice(0, 70)}`;
    if (e.startsWith("cron ")) { const m = e.match(/^cron (\w+) (ok|error)/); return m ? `${({ scout: "Scout", publisher: "Publisher", tracker: "Tracker", notify: "Tagesbericht" } as any)[m[1]] ?? m[1]} ${m[2] === "ok" ? "gelaufen" : "Fehler"}` : e; }
    if (e.startsWith("campaign_patch")) return `Kampagne aktualisiert · ${c}`;
    if (e.startsWith("rss_check")) return `RSS geprüft: ${p.new ?? 0} neue Videos${e.includes("errors=") ? " · Fehler" : ""}`;
    if (e.startsWith("backlog_import")) return `Backlog importiert: ${p.total ?? "?"} Videos im Katalog`;
    if (e.startsWith("shadow_release")) return `Schattenmodus beendet: ${p.clips ?? 0} Clips wieder frei`;
    if (e.startsWith("fan error")) return `Fan-Lauf Fehler: ${e.slice(10, 80)}`;
    if (e.startsWith("submitted:")) return `${e.split(":")[1]} Clips als eingereicht markiert · ${c}`;
    if (e.startsWith("mail:")) return `Vyro-Mail erkannt`;
    return e.slice(0, 80);
  };
  const events = ev.filter((x) => !/^cron (scout|publisher) ok|^rss_check channels=\d+ new=0$/.test(x.event)).slice(0, 15).map((x) => ({ at: x.at, text: nice(x) }));

  return { stages, jobs: jobs.map(({ run_id, ...j }) => j), queue: { ready: q?.ready ?? 0, scheduled: q?.scheduled ?? 0, posted_today: pt?.n ?? 0, pending_submit: ps?.n ?? 0 }, events };
}


// ---------- Quellen (Footage) mit Workflow-Stufe 0–7 ----------
// 0 Upload · 1 Transkript · 2 Momentwahl · 3 Schnitt · 4 QA · 5 Geplant · 6 Gepostet · 7 Eingereicht (aus Clip-Job-Events + Clip-/Post-Status)
export async function buildSources(env: Env, camps: any[], cfg: Record<string, any>, ws = "default") {
  const ev = await db.all<{ campaign_id: string | null; event: string; at: string }>(env, "SELECT campaign_id, event, at FROM events WHERE workspace_id = ? AND campaign_id IS NOT NULL ORDER BY id DESC LIMIT 600", ws);
  const clipAgg = await db.all<any>(env,
    `SELECT campaign_id, COUNT(*) AS n, SUM(status IN ('ready','shadow','scheduled','posted','submitted','archived')) AS ok,
            SUM(status IN ('shadow','scheduled')) AS planned, SUM(status IN ('posted','submitted','archived')) AS posted, SUM(status IN ('submitted','archived')) AS submitted,
            SUM(qa IS NOT NULL) AS qa
     FROM clips WHERE workspace_id = ? AND status NOT IN ('superseded','test_private') GROUP BY campaign_id`, ws);
  const uploads = await db.all<any>(env, "SELECT * FROM uploads WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100", ws);
  const live = await jobProgress(env, ws).catch(() => ({ jobs: [] as any[] }));    // Fortschritt, Lebenszeichen, „hängt"
  const jobOf = (cid: string | null, uid: string | null) =>
    live.jobs.find((j: any) => (cid && j.campaign_id === cid) || (uid && j.upload_id === uid)) ?? null;
  const out: any[] = [];
  const stageOf = (cid: string, kind: string, up: any | null) => {
    const e = ev.filter((x) => x.campaign_id === cid);
    const has = (re: RegExp) => e.some((x) => re.test(x.event));
    const agg = clipAgg.find((x) => x.campaign_id === cid);
    const err = e.find((x) => /^(footage_error|footage_missing|clipper_error)/.test(x.event) || / error /.test(x.event));
    let stage = 0, progress = 0, error: string | null = null;
    if (up && up.status === "uploading") { stage = 0; progress = 0.3; }
    else if (agg?.submitted) stage = 7;
    else if (agg?.posted) stage = 6;
    else if (agg?.planned) stage = 5;
    else if (agg?.ok) stage = kind === "fan" ? 5 : 4, progress = 0;      // fertig, wartet auf Slot
    else if (has(/^stage=render|^clipper_done/)) stage = 3, progress = 0.6;
    else if (has(/^stage=cut/)) stage = 3, progress = 0.2;
    else if (has(/^stage=moments/)) stage = 2, progress = 0.5;
    else if (has(/^stage=transcript/)) stage = 1, progress = 0.5;
    else if (has(/^footage_ok|^stage=download|^clip_jobs?_dispatched/)) stage = 1, progress = 0.1;
    if (err && (!e[0] || e.indexOf(err) <= 2)) { error = err.event.replace(/^\w+ /, "").slice(0, 120); }
    if (agg?.ok && stage >= 5) progress = 1;
    return { stage, progress, error, clips: agg?.ok ?? 0 };
  };
  for (const c of camps) {
    if (c.kind === "fan") continue;
    const foot = (() => { try { return JSON.parse(c.footage || "{}"); } catch { return {}; } })();
    const st = stageOf(c.id, "paid", null);
    out.push({ id: c.id, niche: c.niche_id ?? "mrbeast", name: c.name, size_mb: null, type: "paid", ...st, added: c.created_at, campaign_id: c.id, footage_type: foot.type ?? null,
               job: jobOf(c.id, null) });
  }
  for (const u of uploads) {
    if (u.status === "cancelled") continue;
    if (u.status === "needs_download") {                              // Vorschlag gewählt, wartet auf Upload (abbrechbar)
      out.push({ id: u.id, niche: u.niche_id, name: u.title || u.video_id, size_mb: 0, type: "fan", stage: 0, progress: 0, error: null, clips: 0, added: u.created_at, campaign_id: null,
                 pending: true, auto: /automatisch/.test(u.note ?? ""), video_id: u.video_id ?? null, url: u.video_id ? `https://www.youtube.com/watch?v=${u.video_id}` : null });
      continue;
    }
    const cid = u.campaign_id ?? `fan-${u.id}`;
    const st = stageOf(cid, "fan", u);
    if (u.status === "error" && !st.error) st.error = u.note ?? "Fehler";
    const job = jobOf(u.campaign_id ?? null, u.id);
    if (job && job.status === "stuck" && !st.error) st.error = `${job.stage_label}: ${job.text}`;   // „hängt" schlägt bis in die Quellenzeile durch
    out.push({ id: u.id, niche: u.niche_id, name: u.title || u.key.split("/").pop(), size_mb: Math.round((u.size ?? 0) / 1048576), type: u.kind === "paid" ? "paid" : "fan",
               ...st, added: u.created_at, campaign_id: u.campaign_id ?? null, job });
  }
  return out.sort((a, b) => String(b.added).localeCompare(String(a.added)));
}
