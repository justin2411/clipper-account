// HTTP-API des Workers.
//   GET  /media/<key>                 öffentlich: Clip aus R2 (für Blotato/TikTok)
//   GET  /dashboard                   Dashboard-JSON, Header x-api-key = DASHBOARD_READ_KEY (nur lesen; CORS für Pages)
//   alles unter /api/* braucht  Authorization: Bearer <CLIPFORGE_API_KEY>
//   GET  /api/health | /api/overview
//   GET  /api/campaigns[/:id] | POST /api/campaigns (upsert) | PATCH /api/campaigns/:id | POST /api/campaigns/:id/submitted
//   GET  /api/clips?status=&account=&campaign= | POST /api/clips
//   POST /api/events
//   PUT  /api/media/<key>             Upload nach R2 → {url}
//   POST /api/run/:fn                 scout | fan | publisher | tracker | notify | daily | weekly manuell starten
//   GET  /api/videos?status=&limit=   YouTube-Katalog | POST /api/videos [..] (Upsert, scripts/yt_backlog.py) | PATCH /api/videos/:id
//   POST /api/uploads/:id/start       Clip-Job für einen fertigen Upload (erneut) starten | GET /api/uploads
//   Dashboard-Upload (Header x-api-key = DASHBOARD_READ_KEY oder CLIPFORGE_API_KEY, CORS):
//   POST /sources/presign {niche,name,size,type} → {source_id, upload_url, part_size}
//   PUT  /sources/put/:id?part=N      ein Teilstück (≤ part_size) → R2 Multipart | POST /sources/complete {source_id} → Kampagne + Clip-Job
//   GET  /api/plan?hours=24           geplante Posts (live/shadow)
//   POST /api/shadow_release          Schattenmodus beenden: Schatten-Posts archivieren, Clips wieder 'ready'
//   GET/PUT /api/kv/:key              Key-Value (z.B. yt_cookies: von yt-dlp aktualisierte YouTube-Cookies, nie öffentlich)
//   POST /api/dispatch/:campaign/:account   Clip-Job (GitHub Actions) gezielt für einen Account starten
//   GET  /api/blotato/accounts        verbundene Blotato-Accounts (IDs für config/accounts.yaml)
//   POST /api/telegram/send           {text}  Info-Nachricht (Pipeline meldet z.B. "Clip-Job fertig")
//   Für scripts/vyro_submit.py (Header x-api-key = CLIPFORGE_API_KEY):
//   GET  /submissions/pending         offene Posts [{post_id, campaign_id, campaign_url, post_url, account, account_handle}]
//   POST /submissions/mark            {post_id, status: submitted|failed, note}
//   POST /notify                      {text} → Telegram
import { Env, Row, db, json, keyMatches, logEvent, mediaUrl, nichesOf, nowIso, publishMode, tiktokProfile, tiktokVideo, toCampaign } from "./shared";
import { runScout, dispatchClipJob } from "./scout";
import { runPublisher, publishClipNow, publishCampaignSpaced, plannedPosts, releaseShadow } from "./publisher";
import { runTracker } from "./tracker";
import { runNotify, dailyOverview, weeklyReport } from "./notify";
import { runWeeklyReport, getReport, listReports } from "./report";
import { abStats, startExperiment, stopExperiment, applyWinner, getExperiment, AB_VARIABLES } from "./ab";
import { listLog, LOG_CATS } from "./log";
import { onboardingStatus } from "./onboarding";
import { listSuggestions, pickSuggestion, cancelPick } from "./suggest";
import { listInbox, markNotification, getRules, putRules, recordNotification } from "./inbox";
import { handleChat, confirmAction, listConversations, getConversation, chatBudget } from "./chat";
import { buildCalendar, moveCalendarPost } from "./calendar";
import { buildPayouts, payoutsCsv } from "./payouts";
import { listLibrary, reuseClip } from "./library";
import { runWeeklyReportAI, runAnomalyCheck, detectAnomalies, lastAnomalies } from "./insights";
import { resolveWorkspace, listWorkspaces, createWorkspace, patchWorkspace } from "./workspace";
import { runFan, startUploadJob } from "./fan";
import { getSettings, effectiveSettings, validateSettings, diffSettings, putSettings, listVersions, getVersion, defaultSettings, deepMerge } from "./settings";
import { listTasks, completeTask, resumeAccount, syncTasks } from "./tasks";
import { listReview, reviewAction, feedbackHints } from "./review";
import { buildDashboard } from "./dashboard";
import { BLOTATO, blotatoHeaders, telegram } from "./shared";

export const FUNCTIONS: Record<string, (env: Env) => Promise<unknown>> = {
  scout: runScout, fan: (env) => runFan(env, env.PUBLIC_ORIGIN ?? ""), publisher: runPublisher, tracker: runTracker, notify: runNotify,
  daily: (env) => dailyOverview(env, true), weekly: weeklyReport,
  report: (env) => runWeeklyReportAI(env, true), report_cron: (env) => runWeeklyReportAI(env, false), anomaly: (env) => runAnomalyCheck(env),
  report_plain: (env) => runWeeklyReport(env, true),
};

const CAMPAIGN_FIELDS = ["platform", "kind", "name", "external_url", "status", "rate_per_1k_usd", "min_views", "max_per_post_usd", "min_seconds", "footage", "required", "forbidden", "accounts", "platforms", "budget_total_usd", "budget_used_usd"];
const JSON_FIELDS = new Set(["footage", "required", "forbidden", "accounts", "platforms"]);
const enc = (k: string, v: unknown) => (JSON_FIELDS.has(k) ? JSON.stringify(v ?? (k === "accounts" || k === "platforms" ? [] : {})) : v ?? null);

function authorized(req: Request, env: Env): boolean {
  const key = env.CLIPFORGE_API_KEY;
  if (!key) return false;
  const given = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "") || req.headers.get("x-api-key") || "";
  if (given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function serveMedia(req: Request, env: Env, key: string): Promise<Response> {
  const range = req.headers.get("Range");
  let obj: R2Object | R2ObjectBody | null;
  let opts: R2GetOptions = {};
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m) {
    if (m[1] && m[2]) opts = { range: { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } };
    else if (m[1]) opts = { range: { offset: Number(m[1]) } };
    else if (m[2]) opts = { range: { suffix: Number(m[2]) } };
  }
  obj = req.method === "HEAD" ? await env.CLIPS.head(key) : await env.CLIPS.get(key, opts);
  if (!obj) return new Response("not found", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("Content-Type", obj.httpMetadata?.contentType ?? "video/mp4");
  h.set("Accept-Ranges", "bytes");
  h.set("ETag", obj.httpEtag);
  h.set("Cache-Control", "public, max-age=3600");
  if (req.method === "HEAD") { h.set("Content-Length", String(obj.size)); return new Response(null, { headers: h }); }
  const body = obj as R2ObjectBody;
  if (m && body.range && "offset" in body.range) {
    const off = body.range.offset ?? 0, len = body.range.length ?? obj.size - off;
    h.set("Content-Range", `bytes ${off}-${off + len - 1}/${obj.size}`);
    h.set("Content-Length", String(len));
    return new Response(body.body, { status: 206, headers: h });
  }
  h.set("Content-Length", String(obj.size));
  return new Response(body.body, { headers: h });
}

export async function handleRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const seg = path.split("/").filter(Boolean);

  if (seg[0] === "media" && seg.length >= 2 && (req.method === "GET" || req.method === "HEAD"))
    return serveMedia(req, env, seg.slice(1).map(decodeURIComponent).join("/"));
  if (path === "/") return json({ service: "clipforge", ok: true });

  // Einreich-Schnittstelle für scripts/vyro_submit.py
  if (path === "/submissions/pending" || path === "/submissions/mark" || path === "/notify") {
    if (!env.CLIPFORGE_API_KEY) return json({ error: "CLIPFORGE_API_KEY nicht gesetzt" }, 503);
    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
    const accounts = (() => { try { return JSON.parse(env.ACCOUNTS_JSON || "{}"); } catch { return {}; } })() as Record<string, any>;
    if (path === "/submissions/pending" && req.method === "GET") {
      const rows = await db.all<any>(env,
        `SELECT p.id AS post_id, c.campaign_id, ca.external_url AS campaign_url, p.post_url, c.account, p.submit_attempts
         FROM posts p JOIN clips c ON c.id = p.clip_id JOIN campaigns ca ON ca.id = c.campaign_id
         WHERE p.status = 'posted' AND p.post_url IS NOT NULL AND p.post_url != '' AND p.submitted_at IS NULL
           AND ca.platform = 'vyro' AND ca.status IN ('active','joined') AND p.submit_attempts < 3
         ORDER BY p.posted_at ASC`);
      return json(rows.map((r) => ({ ...r, account_handle: accounts[r.account]?.handle ?? "" })));
    }
    if (path === "/submissions/mark" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Row;
      const post = await db.first<any>(env, "SELECT * FROM posts WHERE id = ?", b.post_id);
      if (!post) return json({ error: "post not found" }, 404);
      const note = String(b.note ?? "").slice(0, 300);
      if (b.status === "submitted") {
        await db.run(env, "UPDATE posts SET submitted_at = ?, submit_note = ? WHERE id = ?", nowIso(), note, post.id);
        const open = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM posts WHERE clip_id = ? AND status = 'posted' AND submitted_at IS NULL", post.clip_id);
        if (!open?.n) await db.run(env, "UPDATE clips SET status = 'submitted' WHERE id = ? AND status = 'posted'", post.clip_id);
        await logEvent(env, `vyro_submitted post=${post.id}`, null);
        return json({ ok: true, post_id: post.id, status: "submitted" });
      }
      if (b.status === "failed") {
        await db.run(env, "UPDATE posts SET submit_note = ?, submit_attempts = submit_attempts + 1 WHERE id = ?", note, post.id);
        await logEvent(env, `vyro_submit_failed post=${post.id} ${note.slice(0, 80)}`, null);
        return json({ ok: true, post_id: post.id, status: "failed", attempts: (post.submit_attempts ?? 0) + 1 });
      }
      return json({ error: "status must be submitted|failed" }, 400);
    }
    if (path === "/notify" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Row;
      return json({ sent: await telegram(env, String(b.text ?? "")) });
    }
    return json({ error: "method not allowed" }, 405);
  }
  // Dashboard-Aktionen (Header x-api-key = DASHBOARD_READ_KEY oder CLIPFORGE_API_KEY, CORS): Review, Settings, Aufgaben, Resume
  if (["review", "settings", "tasks", "report", "ab", "log", "onboarding", "suggest", "inbox", "chat", "calendar", "payouts", "library", "anomalies"].includes(seg[0]) || (seg[0] === "accounts" && seg[2] === "resume")) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "x-api-key, content-type", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS" };
    const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...cors } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const given = req.headers.get("x-api-key") ?? (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const wsr = await resolveWorkspace(env, given, url.searchParams.get("ws") ?? req.headers.get("x-workspace"));
    if (!wsr) return J({ error: "unauthorized" }, 401);
    const ws = wsr.ws; env = wsr.env;
    try {
      const b = async (): Promise<Row> => (await req.json().catch(() => ({}))) as Row;
      if (seg[0] === "review" && !seg[1] && req.method === "GET") return J(await listReview(env, ws));
      if (seg[0] === "report" && seg[1] === "weeks" && req.method === "GET") return J(await listReports(env, ws));
      if (seg[0] === "report" && !seg[1] && req.method === "GET") return J(await getReport(env, url.searchParams.get("week") ?? "latest", ws));
      if (seg[0] === "review" && seg[1] === "bulk" && req.method === "POST") {
        const body = await b(); const out: unknown[] = [];
        for (const id of (Array.isArray(body.ids) ? body.ids : []).slice(0, 50)) out.push({ id, ...(await reviewAction(env, String(id), { action: String(body.action ?? "approve") }, ws)) });
        return J({ results: out });
      }
      if (seg[0] === "review" && seg[1] && req.method === "POST") { const body = await b(); return J(await reviewAction(env, seg[1], body as any, ws)); }
      if (seg[0] === "settings" && !seg[1] && req.method === "GET") return J(await getSettings(env, ws));
      if (seg[0] === "settings" && seg[1] === "effective" && req.method === "GET") return J({ ...(await effectiveSettings(env, url.searchParams.get("account") ?? "A", ws)), ab: await getExperiment(env, ws) });
      if (seg[0] === "onboarding" && !seg[1] && req.method === "GET") return J(await onboardingStatus(env, ws));   // Stufe 6
      // Anomalien (Nachtrag 7): GET /anomalies (zuletzt erkannt) · GET /anomalies?live=1 (jetzt prüfen)
      if (seg[0] === "anomalies" && !seg[1] && req.method === "GET") return J(url.searchParams.get("live") ? { at: nowIso(), found: await detectAnomalies(env, ws) } : await lastAnomalies(env, ws));
      // Clip-Bibliothek (Nachtrag 6): GET /library?q=&status=&account=&source=&min_score=&min_views=&sort=&limit=&offset= · POST /library/:id/reuse {platform}
      if (seg[0] === "library" && !seg[1] && req.method === "GET") return J(await listLibrary(env, {
        q: url.searchParams.get("q") ?? "", status: url.searchParams.get("status") ?? "all", account: url.searchParams.get("account") ?? "all", source: url.searchParams.get("source") ?? "all",
        min_score: Number(url.searchParams.get("min_score") || 0), min_views: Number(url.searchParams.get("min_views") || 0),
        sort: url.searchParams.get("sort") ?? "new", limit: Number(url.searchParams.get("limit") || 40), offset: Number(url.searchParams.get("offset") || 0) }, ws));
      if (seg[0] === "library" && seg[1] && seg[2] === "reuse" && req.method === "POST") { const body = (await b()) as any; const r = await reuseClip(env, seg[1], String(body.platform ?? ""), ws); return J(r, r.ok ? 200 : 400); }
      // Auszahlungen & Abgleich (Nachtrag 5): GET /payouts?days=90 · ?csv=1 (Kampagnen) · ?csv=posts
      if (seg[0] === "payouts" && !seg[1] && req.method === "GET") {
        const data = await buildPayouts(env, Number(url.searchParams.get("days") || 90), ws);
        const csv = url.searchParams.get("csv");
        if (csv) return new Response(payoutsCsv(data, csv === "posts" ? "posts" : "campaigns"),
          { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="auszahlungen-${csv === "posts" ? "posts" : "kampagnen"}.csv"`, ...cors } });
        return J(data);
      }
      // Kalender (Nachtrag 4): GET /calendar?week=0|-1|1 · POST /calendar/move {post_id, at}
      if (seg[0] === "calendar" && !seg[1] && req.method === "GET") return J(await buildCalendar(env, Number(url.searchParams.get("week") || 0), ws));
      if (seg[0] === "calendar" && seg[1] === "move" && req.method === "POST") { const body = (await b()) as any; const r = await moveCalendarPost(env, String(body.post_id ?? ""), String(body.at ?? ""), ws); return J(r, r.ok ? 200 : 400); }
      // Chat (Nachtrag 3): POST /chat {conversation_id?, message, context, force?} · GET /chat (Konversationen) · GET /chat/:id · POST /chat/confirm {action_id, confirm_token|cancel}
      if (seg[0] === "chat" && !seg[1] && req.method === "POST") { const r = await handleChat(env, (await b()) as any, ws); return J(r, r.ok ? 200 : 400); }
      if (seg[0] === "chat" && !seg[1] && req.method === "GET") return J({ conversations: await listConversations(env, ws), budget: await chatBudget(env, ws) });
      if (seg[0] === "chat" && seg[1] === "confirm" && req.method === "POST") { const r = await confirmAction(env, (await b()) as any, ws); return J(r, r.ok ? 200 : 400); }
      if (seg[0] === "chat" && seg[1] && req.method === "GET") { const c = await getConversation(env, seg[1], ws); return c ? J(c) : J({ error: "not found" }, 404); }
      // Benachrichtigungszentrale (Nachtrag 2): GET /inbox?filter=unread|open|done|all&kind=&before= · POST /inbox/{id|all}/{read|done|unread|reopen} · GET/PUT /inbox/rules
      if (seg[0] === "inbox" && !seg[1] && req.method === "GET") return J(await listInbox(env, { filter: url.searchParams.get("filter") ?? "open", kind: url.searchParams.get("kind") ?? "all", limit: Number(url.searchParams.get("limit") || 40), before: Number(url.searchParams.get("before") || 0) }, ws));
      if (seg[0] === "inbox" && seg[1] === "rules" && req.method === "GET") return J(await getRules(env, ws));
      if (seg[0] === "inbox" && seg[1] === "rules" && req.method === "PUT") return J(await putRules(env, (await b()) as any, ws));
      if (seg[0] === "inbox" && seg[1] && ["read", "done", "unread", "reopen"].includes(seg[2] ?? "") && req.method === "POST") return J(await markNotification(env, seg[1] === "all" ? "all" : Number(seg[1]), seg[2] as any, ws));
      // Vorschläge (Nischen-Seite): GET /suggest?niche= · POST /suggest/pick {video_id} · POST /suggest/cancel {upload_id}
      if (seg[0] === "suggest" && !seg[1] && req.method === "GET") return J(await listSuggestions(env, url.searchParams.get("niche") ?? nichesOf(env)[0]?.key ?? "", ws, Number(url.searchParams.get("limit") || 8)));
      if (seg[0] === "suggest" && seg[1] === "pick" && req.method === "POST") { const body = (await b()) as any; const r = await pickSuggestion(env, String(body.video_id ?? ""), ws, false); return J(r, r.ok ? 200 : 400); }
      if (seg[0] === "suggest" && seg[1] === "cancel" && req.method === "POST") { const body = (await b()) as any; const r = await cancelPick(env, String(body.upload_id ?? ""), ws); return J(r, r.ok ? 200 : 400); }
      // Ereignis-Log (Stufe 5): ?cat=error|reject|killswitch|upload|post|job|settings|all &q= &limit= &before=<id>
      if (seg[0] === "log" && !seg[1] && req.method === "GET") return J({ ...(await listLog(env, { cat: url.searchParams.get("cat") ?? "all", q: url.searchParams.get("q") ?? "", limit: Number(url.searchParams.get("limit") || 60), before: Number(url.searchParams.get("before") || 0) }, ws)), cats: LOG_CATS });
      // A/B-Test (Stufe 4)
      if (seg[0] === "ab" && !seg[1] && req.method === "GET") return J({ ...(await abStats(env, ws)), variables: AB_VARIABLES });
      if (seg[0] === "ab" && !seg[1] && req.method === "POST") { const r = await startExperiment(env, (await b()) as any, ws); return J(r, r.ok ? 200 : 400); }
      if (seg[0] === "ab" && seg[1] === "stop" && req.method === "POST") return J(await stopExperiment(env, ws));
      if (seg[0] === "ab" && seg[1] === "apply" && req.method === "POST") { const body = (await b()) as any; const r = await applyWinner(env, String(body.value ?? ""), !!body.confirm, ws); return J(r, r.ok || r.preview ? 200 : 400); }
      if (seg[0] === "settings" && !seg[1] && req.method === "PUT") {
        const body = (await b()) as any;
        const cur = await getSettings(env, ws);
        const next = { global: { ...cur.global, ...(body.global ?? {}) }, niches: body.niches ?? cur.niches, accounts: body.accounts ?? cur.accounts };
        const errors = validateSettings(next);
        if (errors.length) return J({ ok: false, errors }, 400);
        const diff = diffSettings(env, cur, next);
        if (!body.confirm || body.preview || url.searchParams.get("preview") === "1") return J({ ok: false, preview: true, diff, hint: "Mit confirm:true senden, um zu schreiben" });   // Stufe 3: Diff zuerst, Bestätigung nötig
        if (!diff.length) return J({ ok: true, unchanged: true, diff });
        const r = await putSettings(env, next, ws, diff);
        await logEvent(env, `settings_saved changes=${diff.length} version=${r.version}`);
        return J({ ok: true, ...r, diff });
      }
      if (seg[0] === "settings" && seg[1] === "versions" && req.method === "GET") return J(await listVersions(env, ws));
      if (seg[0] === "settings" && seg[1] === "reset" && req.method === "POST") {       // Stufe 3: auf Version oder Standard zurücksetzen (Diff zuerst)
        const body = (await b()) as any;
        const cur = await getSettings(env, ws);
        const target = body.version ? await getVersion(env, Number(body.version), ws) : defaultSettings(env, ws);
        if (!target) return J({ ok: false, error: "Version nicht gefunden" }, 404);
        const def = defaultSettings(env, ws), niches: Record<string, any> = {};
        for (const k of Object.keys(def.niches)) niches[k] = deepMerge(def.niches[k], target.niches?.[k] ?? {});   // ältere Stände ohne neue Felder: Defaults auffüllen
        const next = { global: { ...cur.global, shadow: target.global?.shadow ?? cur.global.shadow }, niches, accounts: target.accounts ?? cur.accounts };
        const errors = validateSettings(next);
        if (errors.length) return J({ ok: false, errors }, 400);
        const diff = diffSettings(env, cur, next);
        if (!body.confirm) return J({ ok: false, preview: true, diff, target: body.version ? `Version ${body.version}` : "Standard" });
        if (!diff.length) return J({ ok: true, unchanged: true, diff });
        const r = await putSettings(env, next, ws, diff);
        await logEvent(env, `settings_reset target=${body.version ? "v" + body.version : "default"} changes=${diff.length} version=${r.version}`);
        return J({ ok: true, ...r, diff });
      }
      if (seg[0] === "tasks" && !seg[1] && req.method === "GET") { await syncTasks(env, ws); return J(await listTasks(env, ws)); }
      if (seg[0] === "tasks" && seg[1] && seg[2] === "done" && req.method === "POST") return J({ ok: await completeTask(env, seg[1], "user"), id: seg[1] });
      if (seg[0] === "accounts" && seg[1] && seg[2] === "resume" && req.method === "POST") return J(await resumeAccount(env, seg[1], ws));
      return J({ error: "not found" }, 404);
    } catch (e: any) { return J({ error: String(e?.message ?? e) }, 500); }
  }
  // Dashboard-Upload nach R2 (Multipart über den Worker – Browser lädt Teilstücke, keine R2-Schlüssel im Browser)
  if (seg[0] === "sources") {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "x-api-key, content-type", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS" };
    const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...cors } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const given = req.headers.get("x-api-key") ?? (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const wsr = await resolveWorkspace(env, given, url.searchParams.get("ws") ?? req.headers.get("x-workspace"));
    if (!wsr) return J({ error: "unauthorized" }, 401);
    const ws = wsr.ws; env = wsr.env;
    const PART = 25 * 1024 * 1024;
    try {
      if (seg[1] === "presign" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as Row;
        const niche = nichesOf(env).find((n) => n.key === b.niche);
        if (!niche) return J({ error: `niche ${b.niche} unknown` }, 400);
        const pending = b.video_id ? await db.first<any>(env, "SELECT id FROM uploads WHERE workspace_id = ? AND video_id = ? AND status = 'needs_download'", ws, String(b.video_id)) : null;
        const id = pending?.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 16);       // Vorschlag „Nehmen“: Upload hängt sich an die wartende Quelle
        const safe = String(b.name ?? "footage.mp4").replace(/[^\w.\-]+/g, "_").slice(0, 80);
        const key = `uploads/${niche.key}/${id}/${safe.toLowerCase().endsWith(".mp4") || safe.toLowerCase().endsWith(".mov") ? safe : safe + ".mp4"}`;
        const mp = await env.CLIPS.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" } });
        if (pending) await db.run(env, "UPDATE uploads SET key = ?, size = ?, upload_id = ?, parts = '[]', status = 'uploading', updated_at = ? WHERE id = ?", key, Number(b.size ?? 0), mp.uploadId, nowIso(), id);
        else await db.run(env, "INSERT INTO uploads (id, niche_id, key, title, size, kind, video_id, upload_id, status, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?)",
          id, niche.key, key, String(b.name ?? "").replace(/\.[^.]+$/, "").slice(0, 120), Number(b.size ?? 0), b.type === "paid" ? "paid" : "fan", (b.video_id as string) ?? null, mp.uploadId, ws);
        await logEvent(env, `upload_started niche=${niche.key} size=${b.size ?? 0} name=${safe}`);
        return J({ source_id: id, upload_url: `${url.origin}/sources/put/${id}`, part_size: PART, key });
      }
      if (seg[1] === "put" && seg[2] && req.method === "PUT") {
        const u = await db.first<any>(env, "SELECT * FROM uploads WHERE id = ? AND workspace_id = ?", seg[2], ws);
        if (!u || !u.upload_id) return J({ error: "upload not found" }, 404);
        const part = Number(url.searchParams.get("part") || 1);
        if (!req.body) return J({ error: "leerer Body" }, 400);
        const mp = env.CLIPS.resumeMultipartUpload(u.key, u.upload_id);
        const res = await mp.uploadPart(part, req.body);
        const parts = (JSON.parse(u.parts || "[]") as { partNumber: number; etag: string }[]).filter((p) => p.partNumber !== part);
        parts.push({ partNumber: res.partNumber, etag: res.etag });
        await db.run(env, "UPDATE uploads SET parts = ?, updated_at = ? WHERE id = ?", JSON.stringify(parts), nowIso(), u.id);
        return J({ part: res.partNumber, etag: res.etag, parts: parts.length });
      }
      if (seg[1] === "complete" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as Row;
        const u = await db.first<any>(env, "SELECT * FROM uploads WHERE id = ? AND workspace_id = ?", b.source_id, ws);
        if (!u) return J({ error: "upload not found" }, 404);
        if (u.status === "uploading") {
          const parts = (JSON.parse(u.parts || "[]") as { partNumber: number; etag: string }[]).sort((a, c) => a.partNumber - c.partNumber);
          if (!parts.length) return J({ error: "keine Teilstücke hochgeladen" }, 400);
          const obj = await env.CLIPS.resumeMultipartUpload(u.key, u.upload_id).complete(parts);
          await db.run(env, "UPDATE uploads SET status = 'uploaded', size = ?, updated_at = ? WHERE id = ?", obj.size, nowIso(), u.id);
          await logEvent(env, `upload_done niche=${u.niche_id} bytes=${obj.size} id=${u.id}`);
        }
        const r = await startUploadJob(env, u.id, url.origin, !!b.preview);
        if (r.ok && b.task_id) await completeTask(env, String(b.task_id), "auto");
        return J({ ok: r.ok, source_id: u.id, campaign: r.campaign, status: r.status, error: r.error ?? null }, r.ok ? 200 : 502);
      }
      return J({ error: "not found" }, 404);
    } catch (e: any) {
      return J({ error: String(e?.message ?? e) }, 500);
    }
  }
  if (path === "/dashboard") {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "x-api-key, content-type", "Access-Control-Allow-Methods": "GET, OPTIONS" };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const wsr = await resolveWorkspace(env, req.headers.get("x-api-key") ?? "", url.searchParams.get("ws") ?? req.headers.get("x-workspace"));
    if (!wsr) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...cors } });
    try {
      return new Response(JSON.stringify(await buildDashboard(wsr.env, wsr.ws)), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 500, headers: { "Content-Type": "application/json", ...cors } });
    }
  }

  if (seg[0] !== "api") return new Response("not found", { status: 404 });

  if (!env.CLIPFORGE_API_KEY) return json({ error: "CLIPFORGE_API_KEY nicht gesetzt (wrangler secret put CLIPFORGE_API_KEY)" }, 503);
  if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
  const rest = seg.slice(1);
  const body = async (): Promise<Row> => (req.headers.get("Content-Type")?.includes("json") ? ((await req.json()) as Row) : {});

  try {
    // health / overview
    if (rest[0] === "health") return json({ ok: true, time: nowIso(), mode: { paid: publishMode(env, "paid"), fan: publishMode(env, "fan") }, draft: publishMode(env) === "draft",
      configured: { blotato: !!env.BLOTATO_API_KEY, telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), gmail: !!env.GMAIL_REFRESH_TOKEN, github: !!env.GITHUB_TOKEN, accounts: !!env.ACCOUNTS_JSON } });
    if (rest[0] === "overview") {
      const counts = async (t: string) => db.all(env, `SELECT status, COUNT(*) AS n FROM ${t} GROUP BY status`);
      return json({ campaigns: await counts("campaigns"), clips: await counts("clips"), posts: await counts("posts"),
        accounts: await db.all(env, "SELECT * FROM account_state"), events: await db.all(env, "SELECT * FROM events ORDER BY id DESC LIMIT 20") });
    }

    // campaigns
    if (rest[0] === "campaigns") {
      if (req.method === "GET" && !rest[1]) return json((await db.all(env, "SELECT * FROM campaigns ORDER BY created_at DESC")).map(toCampaign));
      if (req.method === "POST" && !rest[1]) {
        const b = await body();
        if (!b.id || !b.platform || !b.name) return json({ error: "id, platform, name erforderlich" }, 400);
        const keys = ["id", ...CAMPAIGN_FIELDS.filter((k) => k in b)];
        const sets = keys.filter((k) => k !== "id").map((k) => `${k} = excluded.${k}`).join(", ");
        await db.run(env, `INSERT INTO campaigns (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${sets}`,
          ...keys.map((k) => enc(k, b[k])));
        return json(toCampaign((await db.first(env, "SELECT * FROM campaigns WHERE id = ?", b.id))!), 201);
      }
      const id = rest[1];
      if (!id) return json({ error: "not found" }, 404);
      const row = await db.first(env, "SELECT * FROM campaigns WHERE id = ?", id);
      if (!row) return json({ error: `campaign ${id} not found` }, 404);
      if (req.method === "GET" && !rest[2]) return json(toCampaign(row));
      if (req.method === "PATCH" && !rest[2]) {
        const b = await body();
        const keys = CAMPAIGN_FIELDS.filter((k) => k in b);
        if (!keys.length) return json({ error: "keine Felder" }, 400);
        await db.run(env, `UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => enc(k, b[k])), id);
        await logEvent(env, `campaign_patch:${keys.join(",")}`, id);
        return json(toCampaign((await db.first(env, "SELECT * FROM campaigns WHERE id = ?", id))!));
      }
      if (req.method === "POST" && rest[2] === "submitted") {
        // Nur wirklich gepostete Clips (Post-URL vorhanden) gelten als eingereicht; geplante bleiben unberührt,
        // sonst löscht der Tracker ihre Dateien, bevor Blotato sie posten kann.
        const now = nowIso();
        const clips = await db.all<{ id: string }>(env,
          `SELECT DISTINCT c.id FROM clips c JOIN posts p ON p.clip_id = c.id
           WHERE c.campaign_id = ? AND c.status = 'posted' AND p.status = 'posted' AND p.post_url IS NOT NULL AND p.submitted_at IS NULL`, id);
        for (const c of clips) {
          await db.run(env, "UPDATE posts SET submitted_at = ? WHERE clip_id = ? AND status = 'posted' AND submitted_at IS NULL", now, c.id);
          await db.run(env, "UPDATE clips SET status = 'submitted' WHERE id = ?", c.id);
        }
        await logEvent(env, `submitted:${clips.length}`, id);
        return json({ marked: clips.length });
      }
    }

    // clips
    if (rest[0] === "clips" && !rest[1]) {
      if (req.method === "GET") {
        const w: string[] = [], p: unknown[] = [];
        for (const k of ["status", "account", "campaign"]) { const v = url.searchParams.get(k); if (v) { w.push(`${k === "campaign" ? "campaign_id" : k} = ?`); p.push(v); } }
        return json(await db.all(env, `SELECT * FROM clips ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 500`, ...p));
      }
      if (req.method === "POST") {
        const b = await body();
        if (!b.campaign_id || !b.account || !b.media_url) return json({ error: "campaign_id, account, media_url erforderlich" }, 400);
        const id = crypto.randomUUID().replace(/-/g, "");
        // seq = laufende Nummer je Kampagne (atomar im INSERT); Standardstatus 'ready' → Publisher postet zu den Slots
        const j = (v: unknown) => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));
        await db.run(env,
          `INSERT INTO clips (id, campaign_id, account, media_url, caption, hook_type, status, note, seq, duration_s, hook, pinned_comment, video_id, rank, thumb_url,
                              context_line, cover_url, scores, qa, variant)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM clips WHERE campaign_id = ?`,
          id, b.campaign_id, b.account, b.media_url, b.caption ?? null, b.hook_type ?? null, b.status ?? "ready", b.note ?? null,
          b.duration_s ?? null, b.hook ?? null, b.pinned_comment ?? null, b.video_id ?? null, b.rank ?? null, b.thumb_url ?? null,
          b.context_line ?? null, b.cover_url ?? null, j(b.scores), j(b.qa), b.variant ?? null, b.campaign_id);
        const row = await db.first<{ seq: number }>(env, "SELECT seq FROM clips WHERE id = ?", id);
        return json({ id, seq: row?.seq ?? null }, 201);
      }
    }

    // videos (YouTube-Katalog)
    if (rest[0] === "videos") {
      if (req.method === "GET" && !rest[1]) {
        const st = url.searchParams.get("status"), lim = Number(url.searchParams.get("limit") || 100);
        return json(await db.all(env, `SELECT * FROM videos ${st ? "WHERE status = ?" : ""} ORDER BY CASE WHEN published_at >= ? THEN 0 ELSE 1 END, views DESC LIMIT ?`,
          ...(st ? [st] : []), new Date(Date.now() - 30 * 86400000).toISOString(), lim));
      }
      if (req.method === "POST" && !rest[1]) {
        const items = (await req.json().catch(() => [])) as any[];
        if (!Array.isArray(items)) return json({ error: "Array erwartet" }, 400);
        let added = 0, updated = 0;
        for (const v of items) {
          if (!v?.id || !v?.channel_id) continue;
          const r = await db.run(env,
            `INSERT INTO videos (id, channel_id, channel_name, title, url, published_at, views, duration_s, is_short, source, status, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET views = MAX(videos.views, excluded.views), duration_s = COALESCE(excluded.duration_s, videos.duration_s),
               published_at = COALESCE(videos.published_at, excluded.published_at), title = COALESCE(videos.title, excluded.title),
               is_short = MAX(videos.is_short, excluded.is_short)`,
            v.id, v.channel_id, v.channel_name ?? null, v.title ?? null, v.url ?? `https://www.youtube.com/watch?v=${v.id}`, v.published_at ?? null,
            Number(v.views ?? 0), v.duration_s ?? null, v.is_short ? 1 : 0, v.source ?? "backlog",
            v.is_short || (v.duration_s != null && v.duration_s < 180) ? "skipped" : "new", v.is_short ? "short" : (v.duration_s != null && v.duration_s < 180 ? "too short" : null));
          if (r.meta.changes) { if (r.meta.last_row_id && (r.meta as any).changed_db) added++; else updated++; }
        }
        const total = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM videos");
        await logEvent(env, `backlog_import items=${items.length} total=${total?.n ?? 0}`);
        return json({ received: items.length, total: total?.n ?? 0 }, 201);
      }
      if (req.method === "PATCH" && rest[1]) {
        const b = await body();
        const fields = ["status", "note", "duration_s", "views", "is_short", "campaign_id"].filter((k) => k in b);
        if (!fields.length) return json({ error: "keine Felder" }, 400);
        await db.run(env, `UPDATE videos SET ${fields.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...fields.map((k) => b[k] ?? null), nowIso(), rest[1]);
        return json(await db.first(env, "SELECT * FROM videos WHERE id = ?", rest[1]));
      }
    }
    // Uploads: Liste | Clip-Job für einen fertigen Upload (erneut) starten
    if (rest[0] === "uploads" && !rest[1] && req.method === "GET") return json(await db.all(env, "SELECT id, niche_id, key, title, size, kind, status, campaign_id, note, created_at, updated_at FROM uploads ORDER BY created_at DESC LIMIT 200"));
    if (rest[0] === "uploads" && rest[1] && rest[2] === "start" && req.method === "POST") return json(await startUploadJob(env, rest[1], url.origin, !!url.searchParams.get("preview")));
    if (rest[0] === "uploads" && rest[1] && !rest[2] && req.method === "PATCH") {
      const b = await body();
      const fields = ["status", "note", "title"].filter((k) => k in b);
      if (!fields.length) return json({ error: "keine Felder" }, 400);
      await db.run(env, `UPDATE uploads SET ${fields.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...fields.map((k) => b[k] ?? null), nowIso(), rest[1]);
      return json(await db.first(env, "SELECT * FROM uploads WHERE id = ?", rest[1]));
    }
    // Plan der nächsten Stunden (live + shadow)
    if (rest[0] === "plan" && req.method === "GET") return json(await plannedPosts(env, Number(url.searchParams.get("hours") || 24)));
    // Schattenmodus beenden (danach PUBLISH_MODE=live deployen)
    if (rest[0] === "shadow_release" && req.method === "POST") return json(await releaseShadow(env));

    // Pipeline: wirksame Einstellungen je Account + Few-Shot-Feedback (Momentwahl/QA)
    if (rest[0] === "settings" && rest[1] === "effective" && req.method === "GET") return json({ ...(await effectiveSettings(env, url.searchParams.get("account") ?? "A")), ab: await getExperiment(env) });
    if (rest[0] === "settings" && !rest[1] && req.method === "GET") return json(await getSettings(env));
    if (rest[0] === "feedback" && req.method === "GET") return json(await feedbackHints(env, url.searchParams.get("niche")));

    // kv (nur mit API-Key; Werte werden nie über /media ausgeliefert)
    if (rest[0] === "kv" && rest[1]) {
      if (req.method === "GET") {
        const row = await db.first<any>(env, "SELECT key, value, updated_at FROM kv WHERE key = ?", rest[1]);
        return row ? json(row) : json({ error: "not found" }, 404);
      }
      if (req.method === "PUT" || req.method === "POST") {
        const ct = req.headers.get("Content-Type") ?? "";
        const value = ct.includes("json") ? String(((await req.json()) as any)?.value ?? "") : await req.text();
        await db.run(env, "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", rest[1], value, nowIso());
        await logEvent(env, `kv_set ${rest[1]} bytes=${value.length}`);
        return json({ key: rest[1], bytes: value.length });
      }
      if (req.method === "DELETE") { await db.run(env, "DELETE FROM kv WHERE key = ?", rest[1]); return json({ ok: true }); }
    }

    // events
    if (rest[0] === "events" && req.method === "POST") {
      const b = await body();
      if (!b.event) return json({ error: "event erforderlich" }, 400);
      await logEvent(env, String(b.event), (b.campaign_id as string) ?? null);
      return json({ ok: true }, 201);
    }

    // media upload
    if (rest[0] === "media" && rest.length >= 2 && req.method === "PUT") {
      const key = rest.slice(1).map(decodeURIComponent).join("/");
      if (!req.body) return json({ error: "leerer Body" }, 400);
      await env.CLIPS.put(key, req.body, { httpMetadata: { contentType: req.headers.get("Content-Type") ?? "video/mp4" } });
      return json({ key, url: mediaUrl(url.origin, key) }, 201);
    }
    if (rest[0] === "media" && rest.length >= 2 && req.method === "DELETE") {
      await env.CLIPS.delete(rest.slice(1).map(decodeURIComponent).join("/"));
      return json({ ok: true });
    }

    // manual run
    // Workspaces (Stufe 7): GET /api/workspaces · POST {id,name,config?} → read_key einmalig · PATCH /api/workspaces/:id {name?,config?,rotate_key?}
    if (rest[0] === "workspaces" && !rest[1] && req.method === "GET") return json(await listWorkspaces(env));
    if (rest[0] === "workspaces" && !rest[1] && req.method === "POST") { const r = await createWorkspace(env, (await body()) as any); return json(r, r.ok ? 200 : 400); }
    if (rest[0] === "workspaces" && rest[1] && req.method === "PATCH") { const r = await patchWorkspace(env, rest[1], (await body()) as any); return json(r, r.ok ? 200 : 404); }
    if (rest[0] === "run" && rest[1] && req.method === "POST") {
      const fn = FUNCTIONS[rest[1]];
      if (!fn) return json({ error: `unbekannt: ${rest[1]}` }, 404);
      return json({ fn: rest[1], result: await fn(env) });
    }

    // einen 'ready'-Clip sofort veröffentlichen (statt auf den nächsten Slot zu warten); ?at=<ISO> für einen festen Zeitpunkt
    if (rest[0] === "publish_now" && rest[1] && req.method === "POST") {
      return json(await publishClipNow(env, rest[1], url.searchParams.get("at")));
    }
    // alle 'ready'-Clips einer Kampagne zeitversetzt (erster je Account sofort, dann alle ?gap=45 Minuten)
    if (rest[0] === "publish_campaign" && rest[1] && req.method === "POST") {
      return json(await publishCampaignSpaced(env, rest[1], Number(url.searchParams.get("gap") || 45)));
    }

    // go live: Entwurfs-Clips wieder freigeben (nach Sichtprüfung, BLOTATO_DRAFT=false deployen)
    if (rest[0] === "go_live" && req.method === "POST") {
      const r = await db.run(env, "UPDATE clips SET status = 'ready' WHERE status = 'drafted'");
      await db.run(env, "UPDATE account_state SET paused = 0, reason = NULL WHERE reason = 'review'");
      await logEvent(env, `go_live: ${r.meta.changes} drafted clips → ready, review-pause aufgehoben`);
      return json({ released: r.meta.changes, mode: { paid: publishMode(env, "paid"), fan: publishMode(env, "fan") } });
    }

    // Account-Regeln: PATCH /api/accounts/:id {paused, paused_until, reason, max_per_day, min_gap_min, rules_until}; GET /api/accounts
    if (rest[0] === "accounts" && rest[1] && req.method === "PATCH") {
      const b = await body();
      const fields = ["paused", "paused_until", "reason", "max_per_day", "min_gap_min", "rules_until"].filter((k) => k in b);
      if (!fields.length) return json({ error: "keine Felder" }, 400);
      await db.run(env, `UPDATE account_state SET ${fields.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE account = ?`,
        ...fields.map((k) => (k === "paused" ? (b[k] ? 1 : 0) : b[k] ?? null)), nowIso(), rest[1]);
      await logEvent(env, `account_rules ${rest[1]}: ${fields.map((k) => `${k}=${b[k]}`).join(" ")}`);
      return json(await db.first(env, "SELECT * FROM account_state WHERE account = ?", rest[1]));
    }
    if (rest[0] === "accounts" && !rest[1] && req.method === "GET") return json(await db.all(env, "SELECT * FROM account_state"));

    // manual clip job dispatch for one account
    if (rest[0] === "dispatch" && rest[1] && rest[2] && req.method === "POST") {
      const camp = await db.first(env, "SELECT id FROM campaigns WHERE id = ?", rest[1]);
      if (!camp) return json({ error: `campaign ${rest[1]} not found` }, 404);
      const status = await dispatchClipJob(env, rest[1], rest[2], url.searchParams.get("preview") ? { preview: "true" } : {});
      if (status === 204) await logEvent(env, `clip_job_dispatched account=${rest[2]} (manual)`, rest[1]);
      return json({ campaign: rest[1], account: rest[2], github_status: status, ok: status === 204 }, status === 204 ? 200 : 502);
    }

    // TikTok-Zahlen live (Test/Debug): GET /api/tiktok/profile/:handle | GET /api/tiktok/video?url=
    if (rest[0] === "tiktok" && rest[1] === "profile" && rest[2] && req.method === "GET") return json({ handle: rest[2], stats: await tiktokProfile(rest[2]) });
    if (rest[0] === "tiktok" && rest[1] === "video" && req.method === "GET") return json({ url: url.searchParams.get("url"), stats: await tiktokVideo(url.searchParams.get("url") ?? "") });

    // blotato accounts
    if (rest[0] === "blotato" && rest[1] === "accounts" && req.method === "GET") {
      if (!env.BLOTATO_API_KEY) return json({ error: "BLOTATO_API_KEY nicht gesetzt" }, 503);
      const r = await fetch(`${BLOTATO}/users/me/accounts`, { headers: blotatoHeaders(env) });
      return json(await r.json().catch(() => ({ status: r.status })), r.status);
    }

    // telegram photo (multipart: photo=<file>, caption=<text>) → Bot API sendPhoto
    if (rest[0] === "telegram" && rest[1] === "photo" && req.method === "POST") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ sent: false, error: "telegram nicht konfiguriert" });
      const form = await req.formData();
      const photo = form.get("photo");
      if (!(photo instanceof File)) return json({ error: "photo fehlt" }, 400);
      const rec = await recordNotification(env, String(form.get("caption") ?? ""), null, "preview");   // Nachtrag 2: Standbilder der Pipeline im Posteingang
      if (!rec.telegram) return json({ sent: false, muted: true });
      const out = new FormData();
      out.set("chat_id", env.TELEGRAM_CHAT_ID);
      out.set("caption", String(form.get("caption") ?? "").slice(0, 1024));
      out.set("photo", photo, photo.name || "frame.jpg");
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: out });
      return json({ sent: r.ok, status: r.status });
    }

    // telegram info message
    if (rest[0] === "telegram" && (rest[1] === "send" || rest[1] === "test") && req.method === "POST") {
      const b = await body();
      return json({ sent: await telegram(env, String(b.text ?? "ClipForge: Telegram-Test ✅")) });
    }

    return json({ error: "not found" }, 404);
  } catch (e: any) {
    console.log("[api] error", e?.message ?? e);
    return json({ error: String(e?.message ?? e) }, 500);
  }
}
