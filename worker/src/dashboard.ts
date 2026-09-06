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
  const pipeline = await buildPipeline(env);
  return {
    pipeline,
    month, currency: "USD", eur_rate: EUR_RATE,
    totals: { revenue: Math.round(rev?.s ?? 0), costs, pending, week_delta: Math.round(revWeek?.s ?? 0) },
    history, campaigns, accounts, insights, tasks, goal_monthly: GOAL_MONTHLY,
    meta: { generated_at: now.toISOString(), days_left: daysLeft, posts_posted: postedAll.length, posts_scheduled: posts.filter((p) => p.status === "scheduled").length,
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

export async function buildPipeline(env: Env) {
  const now = Date.now();
  const ev = await db.all<{ id: number; campaign_id: string | null; event: string; at: string }>(env, "SELECT * FROM events ORDER BY id DESC LIMIT 200");
  const camps = await db.all<{ id: string; name: string }>(env, "SELECT id, name FROM campaigns");
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
  const active = await db.all<any>(env, "SELECT id, name, footage FROM campaigns WHERE status='active'");
  const footBad = active.filter((c) => { const e = ev.find((x) => x.campaign_id === c.id && /^footage_/.test(x.event)); return e && e.event.startsWith("footage_missing"); });
  const footageStage: Stage = { key: "footage", label: "Footage", status: footBad.length ? "error" : active.length ? "ok" : "idle",
    info: footBad.length ? `Footage fehlt: ${footBad.map((c) => c.name).join(", ")}` : `${active.length} Kampagne${active.length === 1 ? "" : "n"} aktiv` };

  // Queue
  const q = await db.first<any>(env,
    `SELECT SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) AS scheduled FROM clips`);
  const today = new Date().toISOString().slice(0, 10);
  const pt = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM posts WHERE status='posted' AND substr(posted_at,1,10)=?", today);
  const ps = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM posts WHERE status='posted' AND submitted_at IS NULL AND post_url IS NOT NULL");
  const nextSlot = await db.first<{ t: string }>(env, "SELECT MIN(scheduled_at) AS t FROM posts WHERE status='scheduled' AND scheduled_at > ?", new Date().toISOString());
  const paused = await db.all<any>(env, "SELECT account FROM account_state WHERE paused=1");

  const stages: Stage[] = [
    cronStage("scout", "Scout", 10, (e, at) => { const m = e.match(/"(new|created|campaigns)":(\d+)/); return `letzte Prüfung ${tmUtc(at)}${m ? ` · ${m[2]} neue` : ""}`; }),
    footageStage,
    clipStage,
    (() => { const s = cronStage("publisher", "Publisher", 30, (_e, at) => `letzter Lauf ${tmUtc(at)}`);
             const extra = paused.length ? `pausiert: ${paused.map((p) => p.account).join(", ")}` : nextSlot?.t ? `nächster Slot ${tmUtc(nextSlot.t)}` : "kein Slot geplant";
             return { ...s, info: `${extra} · ${q?.ready ?? 0} bereit` }; })(),
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
    if (e.startsWith("publisher")) return `Publisher: ${p.scheduled ?? 0} Clips eingeplant`;
    if (e.startsWith("publish_now")) return `Sofort veröffentlicht · ${c} · ${p.account ?? ""}`;
    if (e.startsWith("vyro_submitted")) return `Bei Vyro eingereicht (${p.post ?? ""})`;
    if (e.startsWith("vyro_submit_failed")) return `Vyro-Einreichung fehlgeschlagen`;
    if (e.startsWith("go_live")) return `Freigabe: Publisher wieder aktiv`;
    if (e.startsWith("account_rules")) return `Account-Regel: ${e.replace("account_rules ", "").slice(0, 70)}`;
    if (e.startsWith("cron ")) { const m = e.match(/^cron (\w+) (ok|error)/); return m ? `${({ scout: "Scout", publisher: "Publisher", tracker: "Tracker", notify: "Tagesbericht" } as any)[m[1]] ?? m[1]} ${m[2] === "ok" ? "gelaufen" : "Fehler"}` : e; }
    if (e.startsWith("campaign_patch")) return `Kampagne aktualisiert · ${c}`;
    if (e.startsWith("submitted:")) return `${e.split(":")[1]} Clips als eingereicht markiert · ${c}`;
    if (e.startsWith("mail:")) return `Vyro-Mail erkannt`;
    return e.slice(0, 80);
  };
  const events = ev.filter((x) => !/^cron (scout|publisher) ok/.test(x.event)).slice(0, 15).map((x) => ({ at: x.at, text: nice(x) }));

  return { stages, jobs: jobs.map(({ run_id, ...j }) => j), queue: { ready: q?.ready ?? 0, scheduled: q?.scheduled ?? 0, posted_today: pt?.n ?? 0, pending_submit: ps?.n ?? 0 }, events };
}
