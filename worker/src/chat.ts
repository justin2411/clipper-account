// Chat (Nachtrag 3): POST /chat mit Konversations-ID, Verlauf in D1 je Workspace.
// Router: Regeln + schnelles Modell klassifizieren in data | analysis | action.
//   data     → schnelles Modell (CHAT_MODEL_FAST, Haiku) mit lesenden Tools
//   analysis → starkes Modell (CHAT_MODEL_STRONG) – erzwungen durch Präfix „Analysiere:" oder Knopf „tiefer"
//   action   → schnelles Modell formuliert einen Aktionsvorschlag (handelndes Tool); Ausführung erst nach Bestätigung im UI (confirm_token)
// Alle Zahlen kommen ausschließlich aus Tool-Ergebnissen; jede Antwort listet die genutzten Datenquellen. Tagesbudget 1 $ (danach nur Haiku).
// API-Keys nur im Worker (ANTHROPIC_API_KEY). Antwortformat: kurze Antwort zuerst, nach einer Zeile „---" die Begründung („mehr").
import { Env, db, nowIso, logEvent, nichesOf } from "./shared";
import { accountsOf, plannedPosts, publishClipNow } from "./publisher";
import { getSettings, effectiveSettings, diffSettings, validateSettings, putSettings } from "./settings";
import { listReview, reviewAction } from "./review";
import { listTasks, completeTask, resumeAccount } from "./tasks";
import { abStats } from "./ab";
import { listLog } from "./log";
import { accountHealth } from "./health";
import { getReport } from "./report";
import { listInbox } from "./inbox";
import { BLOTATO, blotatoHeaders } from "./shared";

export type Tier = "data" | "analysis" | "action";
const BUDGET_USD = 1.0;
const PRICES: Record<string, [number, number]> = {             // $ je 1 Mio Tokens (Eingabe, Ausgabe) – konservative Schätzung
  "claude-haiku-4-5-20251001": [1, 5], "claude-sonnet-5": [3, 15], "claude-opus-5": [15, 75], "claude-fable-5-1": [15, 75],
};
const fastModel = (env: Env) => env.CHAT_MODEL_FAST || "claude-haiku-4-5-20251001";
const strongModel = (env: Env) => env.CHAT_MODEL_STRONG || "claude-sonnet-5";
const rid = (n = 12) => crypto.randomUUID().replace(/-/g, "").slice(0, n);

// ---------- Tools ----------
type ToolDef = { name: string; description: string; input_schema: Record<string, unknown>; kind: "read" | "act" };
const TOOLS: ToolDef[] = [
  { kind: "read", name: "get_accounts", description: "Accounts mit Handle, Nische, Follower, Views 7/30 Tage, Ø Views, Pausenstatus und Gesundheits-Ampel.", input_schema: { type: "object", properties: {} } },
  { kind: "read", name: "get_posts", description: "Gepostete/geplante Posts mit Views, Likes, Zeit, Account, Kampagne, Hook. Filter: account, days (Standard 14), status (posted|scheduled|shadow), limit (max 100).",
    input_schema: { type: "object", properties: { account: { type: "string" }, days: { type: "number" }, status: { type: "string" }, limit: { type: "number" } } } },
  { kind: "read", name: "get_campaigns", description: "Kampagnen (paid/fan) mit Status, Rate je 1000 Views, Budget, Clips, Nische.", input_schema: { type: "object", properties: { status: { type: "string" } } } },
  { kind: "read", name: "get_payouts", description: "Auszahlungen (Vyro/Whop) der letzten Tage mit Kampagne. Parameter days (Standard 30).", input_schema: { type: "object", properties: { days: { type: "number" } } } },
  { kind: "read", name: "get_settings", description: "Feinjustierung (Nische → Account-Override): Posting, Schnitt, Momentwahl, Look, Caption, QA. Parameter account (wirksame Werte) oder niche.",
    input_schema: { type: "object", properties: { account: { type: "string" }, niche: { type: "string" } } } },
  { kind: "read", name: "get_events", description: "Ereignis-Log (Fehler, Ablehnungen, Kill-Switch, Uploads, Posts, Jobs, Einstellungen). Filter cat, q (Suche), limit (Standard 30).",
    input_schema: { type: "object", properties: { cat: { type: "string" }, q: { type: "string" }, limit: { type: "number" } } } },
  { kind: "read", name: "get_ab_status", description: "Laufender A/B-Test mit Kennzahlen je Variante und Signifikanz-Hinweis.", input_schema: { type: "object", properties: {} } },
  { kind: "read", name: "get_calendar", description: "Geplante Posts (live und Schatten) der nächsten Stunden je Account mit Slot, Clip und Kampagne. Parameter hours (Standard 48).", input_schema: { type: "object", properties: { hours: { type: "number" } } } },
  { kind: "read", name: "get_health", description: "Gesundheits-Ampel eines Accounts mit Kennzahlen und Begründung (Trend, Anteil < 200 Views, Engagement, Tage seit Post, Kill-Switch-Historie).", input_schema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] } },
  { kind: "read", name: "get_report", description: "Wochenbericht (latest, current oder YYYY-Www).", input_schema: { type: "object", properties: { week: { type: "string" } } } },
  { kind: "read", name: "get_tasks", description: "Offene Aufgaben (Einreichen, Join, Nachschub, Prüfen).", input_schema: { type: "object", properties: {} } },
  { kind: "read", name: "get_review", description: "Clips in der Clip-Vorschau (bereit/geplant/Schatten) mit Hook, Scores, QA.", input_schema: { type: "object", properties: {} } },
  { kind: "read", name: "get_inbox", description: "Offene Benachrichtigungen (Posteingang).", input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  // handelnd – nur als Vorschlag, Ausführung nach Bestätigung
  { kind: "act", name: "pause_account", description: "Account pausieren (Posting stoppen). Parameter account, reason, until (ISO, optional).", input_schema: { type: "object", properties: { account: { type: "string" }, reason: { type: "string" }, until: { type: "string" } }, required: ["account"] } },
  { kind: "act", name: "resume_account", description: "Account wieder freigeben (Pause/Kill-Switch aufheben).", input_schema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] } },
  { kind: "act", name: "review_action", description: "Clip in der Clip-Vorschau freigeben (approve), ablehnen (reject) oder neu rendern (redo) mit Feedback.", input_schema: { type: "object", properties: { clip_id: { type: "string" }, action: { type: "string", enum: ["approve", "reject", "redo"] }, feedback: { type: "string" } }, required: ["clip_id", "action"] } },
  { kind: "act", name: "update_settings", description: "Eine Einstellung der Nische ändern (Pfad wie posts_per_day, visual.anim, cut.max_s, caption.tone). Läuft über den bestehenden Diff.", input_schema: { type: "object", properties: { niche: { type: "string" }, path: { type: "string" }, value: {} }, required: ["path", "value"] } },
  { kind: "act", name: "move_slot", description: "Geplanten Post auf einen anderen Zeitpunkt verschieben. Parameter post_id, at (ISO-Zeit).", input_schema: { type: "object", properties: { post_id: { type: "string" }, at: { type: "string" } }, required: ["post_id", "at"] } },
  { kind: "act", name: "complete_task", description: "Aufgabe als erledigt markieren.", input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
];
const READ_TOOLS = TOOLS.filter((t) => t.kind === "read"), ACT_TOOLS = TOOLS.filter((t) => t.kind === "act");

async function runReadTool(env: Env, name: string, a: any, ws: string): Promise<{ data: unknown; rows: number }> {
  const lim = (n: any, d: number, max = 100) => Math.min(max, Math.max(1, Number(n) || d));
  switch (name) {
    case "get_accounts": {
      const cfg = accountsOf(env); const out: any[] = [];
      for (const [id, c] of Object.entries(cfg) as [string, any][]) {
        const st = await db.first<any>(env, "SELECT paused, reason, paused_until FROM account_state WHERE workspace_id = ? AND account = ?", ws, id);
        const s = await db.first<any>(env, "SELECT followers, views_7d, views_30d, likes_total FROM account_stats WHERE workspace_id = ? AND account = ? ORDER BY day DESC LIMIT 1", ws, id);
        const h = await accountHealth(env, id, ws).catch(() => null);
        out.push({ id, handle: c.handle, niche: c.niche, slots: c.slots, followers: s?.followers ?? null, views_7d: s?.views_7d ?? null, views_30d: s?.views_30d ?? null, likes_total: s?.likes_total ?? null,
                   paused: !!st?.paused, pause_reason: st?.reason ?? null, paused_until: st?.paused_until ?? null, health: h ? { color: h.color, headline: h.headline, reasons: h.reasons } : null });
      }
      return { data: out, rows: out.length };
    }
    case "get_posts": {
      const days = lim(a?.days, 14, 365), limit = lim(a?.limit, 50);
      const where = ["p.workspace_id = ?", "COALESCE(p.posted_at, p.scheduled_at) >= ?"]; const args: unknown[] = [ws, new Date(Date.now() - days * 86400000).toISOString()];
      if (a?.account) { where.push("c.account = ?"); args.push(String(a.account).toUpperCase()); }
      if (a?.status) { where.push("p.status = ?"); args.push(String(a.status)); } else where.push("p.status IN ('posted','submitted','scheduled','shadow')");
      const rows = await db.all<any>(env,
        `SELECT p.id, p.status, p.mode, p.post_url, p.posted_at, p.scheduled_at, COALESCE(p.views, p.views_7d, p.views_72h, p.views_24h) AS views, p.likes, p.submitted_at,
                c.account, c.hook, c.context_line, c.campaign_id, ca.name AS campaign, COALESCE(p.kind, ca.kind) AS kind
         FROM posts p JOIN clips c ON c.id = p.clip_id LEFT JOIN campaigns ca ON ca.id = c.campaign_id WHERE ${where.join(" AND ")} ORDER BY COALESCE(p.posted_at, p.scheduled_at) DESC LIMIT ?`, ...args, limit);
      return { data: rows, rows: rows.length };
    }
    case "get_campaigns": {
      const rows = await db.all<any>(env, `SELECT id, name, platform, kind, niche_id, status, rate_per_1k_usd, min_views, max_per_post_usd, budget_total_usd, budget_used_usd, created_at FROM campaigns WHERE workspace_id = ? ${a?.status ? "AND status = ?" : ""} ORDER BY created_at DESC LIMIT 50`, ws, ...(a?.status ? [String(a.status)] : []));
      for (const r of rows) { const c = await db.first<any>(env, "SELECT COUNT(*) AS n, SUM(status IN ('posted','submitted','archived')) AS posted FROM clips WHERE campaign_id = ?", r.id); r.clips = c?.n ?? 0; r.posted = c?.posted ?? 0; }
      return { data: rows, rows: rows.length };
    }
    case "get_payouts": {                                        // Abgleich: erwartet vs. ausgezahlt, Kosten und Marge je Kampagne
      const { buildPayouts } = await import("./payouts");
      const p = await buildPayouts(env, lim(a?.days, 30, 365), ws);
      return { data: { totals: p.totals, campaigns: p.campaigns.map(({ payouts, ...c }: any) => c), payouts: p.payouts.slice(0, 50), note: p.note }, rows: p.campaigns.length };
    }
    case "get_settings": {
      if (a?.account) return { data: await effectiveSettings(env, String(a.account).toUpperCase(), ws), rows: 1 };
      const s = await getSettings(env, ws);
      return { data: a?.niche ? { niche: a.niche, settings: s.niches[a.niche] ?? null, global: s.global } : s, rows: 1 };
    }
    case "get_events": { const r = await listLog(env, { cat: a?.cat ?? "all", q: a?.q ?? "", limit: lim(a?.limit, 30, 200) }, ws); return { data: r.items, rows: r.items.length }; }
    case "get_ab_status": { const r = await abStats(env, ws); return { data: r, rows: r.variants.length }; }
    case "get_calendar": { const r = await plannedPosts(env, lim(a?.hours, 48, 24 * 14)); return { data: r, rows: (r as any[]).length }; }
    case "get_health": { const r = await accountHealth(env, String(a?.account ?? "A").toUpperCase(), ws); return { data: r, rows: 1 }; }
    case "get_report": { const r = await getReport(env, a?.week ?? "latest", ws); return { data: r, rows: r ? 1 : 0 }; }
    case "get_tasks": { const r = await listTasks(env, ws); return { data: r, rows: r.length }; }
    case "get_review": { const r = await listReview(env, ws); return { data: r.map((c: any) => ({ id: c.id, account: c.account, hook: c.hook, status: c.status, scores: c.scores, qa: c.qa, scheduled_for: c.scheduled_for, campaign: c.source })), rows: r.length }; }
    case "get_inbox": { const r = await listInbox(env, { filter: "open", limit: lim(a?.limit, 20) }, ws); return { data: r.items.map((i: any) => ({ id: i.id, kind: i.kind, title: i.title, created_at: i.created_at })), rows: r.items.length }; }
    default: return { data: { error: `unbekanntes Tool ${name}` }, rows: 0 };
  }
}

/** Handelnde Tools – nur nach Bestätigung (confirmAction). */
async function runActTool(env: Env, name: string, a: any, ws: string): Promise<unknown> {
  switch (name) {
    case "pause_account": {
      const acc = String(a.account).toUpperCase();
      await db.run(env, "UPDATE account_state SET paused = 1, reason = ?, paused_until = ?, updated_at = ? WHERE account = ? AND workspace_id = ?", String(a.reason ?? "chat"), a.until ?? null, nowIso(), acc, ws);
      await logEvent(env, `account_rules ${acc}: paused=1 reason=${a.reason ?? "chat"} paused_until=${a.until ?? "null"} (chat)`);
      return { ok: true, account: acc, paused: true };
    }
    case "resume_account": return resumeAccount(env, String(a.account).toUpperCase(), ws);
    case "review_action": return reviewAction(env, String(a.clip_id), { action: String(a.action), feedback: a.feedback ? String(a.feedback) : undefined }, ws);
    case "update_settings": {
      const cur = await getSettings(env, ws); const next = JSON.parse(JSON.stringify(cur));
      const niche = String(a.niche ?? Object.keys(cur.niches)[0]); if (!next.niches[niche]) return { ok: false, error: `Nische ${niche} unbekannt` };
      const path = String(a.path).split("."); let o: any = next.niches[niche]; for (const k of path.slice(0, -1)) o = o[k] ??= {};
      o[path.at(-1)!] = a.value;
      const errors = validateSettings(next); if (errors.length) return { ok: false, errors };
      const diff = diffSettings(env, cur, next); if (!diff.length) return { ok: true, unchanged: true };
      const r = await putSettings(env, next, ws, diff); await logEvent(env, `settings_saved changes=${diff.length} version=${r.version} (chat)`);
      return { ok: true, ...r, diff };
    }
    case "move_slot": { const { moveCalendarPost } = await import("./calendar"); return moveCalendarPost(env, String(a.post_id), String(a.at), ws); }
    case "complete_task": return { ok: await completeTask(env, String(a.task_id), "user"), task_id: a.task_id };
    default: return { ok: false, error: `unbekannte Aktion ${name}` };
  }
}

/** Geplanten Post verschieben: Schatten → nur Zeit ändern; live → Blotato-Schedule löschen, Post stornieren, Clip neu zur neuen Zeit planen. */
/** Blotato-Zeitplan zu einem geplanten Post finden: unsere gespeicherte postSubmissionId (UUID) ist NICHT die Schedule-ID (numerisch).
 *  Zuordnung über Blotato-Konto und geplante Zeit aus GET /v2/schedules. */
export async function blotatoScheduleId(env: Env, accountId: string, scheduledAt: string): Promise<string | null> {
  if (!env.BLOTATO_API_KEY) return null;
  const r = await fetch(`${BLOTATO}/schedules`, { headers: blotatoHeaders(env) });
  if (!r.ok) return null;
  const j: any = await r.json().catch(() => ({}));
  const want = new Date(scheduledAt).getTime();
  const hit = (j?.items ?? []).find((x: any) => String(x?.draft?.accountId ?? x?.account?.id) === String(accountId) && Math.abs(new Date(x?.scheduledAt ?? 0).getTime() - want) < 60000);
  return hit ? String(hit.id) : null;
}

export async function moveSlot(env: Env, postId: string, at: string, ws = "default") {
  const p = await db.first<any>(env, "SELECT p.*, c.id AS clip, c.account FROM posts p JOIN clips c ON c.id = p.clip_id WHERE p.id = ? AND p.workspace_id = ?", postId, ws);
  if (!p) return { ok: false, error: "Post nicht gefunden" };
  if (!["scheduled", "shadow"].includes(p.status)) return { ok: false, error: `Post ist ${p.status}, nur geplante Posts lassen sich verschieben` };
  const when = new Date(at); if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60000) return { ok: false, error: "Zeitpunkt ungültig oder in der Vergangenheit" };
  if (p.status === "shadow" || !p.blotato_submission_id) {
    await db.run(env, "UPDATE posts SET scheduled_at = ? WHERE id = ?", when.toISOString(), p.id);
    await logEvent(env, `slot_moved post=${p.id} to=${when.toISOString()} (${p.status})`);
    return { ok: true, post_id: p.id, at: when.toISOString(), mode: p.status };
  }
  if (env.BLOTATO_API_KEY) {
    const accId = (accountsOf(env)[p.account] as any)?.blotato?.[p.platform ?? "tiktok"];
    const schedId = accId ? await blotatoScheduleId(env, String(accId), p.scheduled_at) : null;
    if (!schedId) return { ok: false, error: "Der Zeitplan liegt bei Blotato nicht (mehr) vor – bitte dort prüfen; es wurde nichts geändert." };
    const r = await fetch(`${BLOTATO}/schedules/${schedId}`, { method: "DELETE", headers: blotatoHeaders(env) });
    if (!r.ok && r.status !== 404) return { ok: false, error: `Blotato hat das Löschen des Zeitplans abgelehnt (${r.status}) – es wurde nichts geändert.` };
  }
  await db.run(env, "UPDATE posts SET status = 'cancelled' WHERE id = ?", p.id);
  await db.run(env, "UPDATE clips SET status = 'ready' WHERE id = ?", p.clip);
  const res = await publishClipNow(env, p.clip, when.toISOString());
  await logEvent(env, `slot_moved post=${p.id} to=${when.toISOString()} (live, neu geplant)`);
  return { ok: !("error" in res), post_id: p.id, at: when.toISOString(), result: res };
}

// ---------- Anthropic ----------
async function anthropic(env: Env, model: string, system: string, messages: any[], tools: ToolDef[], maxTokens = 1200): Promise<any> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, ...(tools.length ? { tools: tools.map(({ kind, ...t }) => t) } : {}) }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(j?.error?.message ?? JSON.stringify(j)).slice(0, 200)}`);
  return j;
}
const usd = (model: string, u: any) => { const [i, o] = PRICES[model] ?? [3, 15]; return ((u?.input_tokens ?? 0) * i + (u?.output_tokens ?? 0) * o) / 1e6; };

export async function chatBudget(env: Env, ws = "default") {
  const day = new Date().toISOString().slice(0, 10);
  const r = await db.first<any>(env, "SELECT usd, calls FROM chat_usage WHERE workspace_id = ? AND day = ?", ws, day);
  return { day, used_usd: Math.round((r?.usd ?? 0) * 10000) / 10000, calls: r?.calls ?? 0, limit_usd: BUDGET_USD, exhausted: (r?.usd ?? 0) >= BUDGET_USD };
}
async function addUsage(env: Env, ws: string, amount: number) {
  const day = new Date().toISOString().slice(0, 10);
  await db.run(env, "INSERT INTO chat_usage (workspace_id, day, usd, calls) VALUES (?, ?, ?, 1) ON CONFLICT(workspace_id, day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1", ws, day, amount);
}

// ---------- Router ----------
const ACTION_RE = /\b(pausier|pause|stopp|freigeb|freischalt|resume|verschieb|leg[e]? .* (auf|um)|ändere|änder|setz[e]? |stell[e]? .* (auf|um)|erledig|abhak|ablehn|reject|approve|genehmig|neu rendern|redo|aktivier|deaktivier)/i;
const ANALYSIS_RE = /^(analysiere|analyse|warum|wieso|weshalb|erkläre|vergleich|bewerte|was sollte|empfiehl|strategie|woran liegt)/i;
async function route(env: Env, text: string, force?: string): Promise<{ tier: Tier; how: string }> {
  const t = text.trim();
  if (force === "analysis" || /^analysiere\s*:/i.test(t)) return { tier: "analysis", how: "erzwungen" };
  if (ACTION_RE.test(t)) return { tier: "action", how: "regel" };
  if (ANALYSIS_RE.test(t) || t.length > 240) return { tier: "analysis", how: "regel" };
  if (/^(wie viele|wieviel|wie viel|zeig|liste|welche|was ist|wann|wer|status|stand|zahlen|views|follower|posts?|kampagne|auszahlung|aufgaben|kalender|slots?)\b/i.test(t)) return { tier: "data", how: "regel" };
  try {   // unklar → schnelles Modell entscheidet (wenige Tokens)
    const j = await anthropic(env, fastModel(env), "Klassifiziere die Nutzeranfrage an ein Dashboard für TikTok-Clip-Accounts. Antworte nur mit einem Wort: data (Zahlen/Status abfragen), analysis (Warum/Bewertung/Empfehlung) oder action (etwas ändern, pausieren, freigeben, verschieben, erledigen).",
      [{ role: "user", content: t.slice(0, 500) }], [], 5);
    await addUsage(env, env.WS ?? "default", usd(fastModel(env), j.usage));
    const w = String(j.content?.[0]?.text ?? "").toLowerCase();
    return { tier: w.includes("action") ? "action" : w.includes("analysis") ? "analysis" : "data", how: "modell" };
  } catch { return { tier: "data", how: "fallback" }; }
}

const SYSTEM = (env: Env, tier: Tier, ctx: any, ws: string) => `Du bist der Assistent des ClipForge-Dashboards (Workspace ${ws}): automatisierte TikTok-Clips für bezahlte Vyro-Kampagnen und Fan-Content, Accounts ${Object.keys(accountsOf(env)).join(", ")}, Nischen ${nichesOf(env).map((n) => `${n.label} (${n.key})`).join(", ")}.
Kontext des Nutzers: Seite ${ctx?.page ?? "–"}${ctx?.niche ? `, Nische ${ctx.niche}` : ""}${ctx?.account ? `, Account ${ctx.account}` : ""}. Heute ist ${new Date().toISOString().slice(0, 10)} (UTC).
Regeln: Jede Zahl stammt ausschließlich aus Tool-Ergebnissen – nie schätzen oder erfinden; wenn ein Tool keine Daten liefert, sag das. Antworte auf Deutsch, knapp.
Format: Zuerst die kurze Antwort (höchstens 2–3 Sätze, Zahlen zuerst). Danach eine Zeile mit genau "---" und darunter die Begründung/Details (Aufzählung erlaubt). Keine Überschriften, kein Markdown-Fett.
${tier === "action" ? `Der Nutzer will etwas ändern. Prüfe zuerst mit lesenden Tools den Zustand, dann rufe GENAU EIN handelndes Tool mit den passenden Parametern auf – es wird nicht sofort ausgeführt, sondern dem Nutzer als Vorschlag zur Bestätigung gezeigt. Formuliere im Text kurz, was der Vorschlag bewirkt und warum. Nichts löschen.` :
  tier === "analysis" ? `Analysiere gründlich: hole die nötigen Daten mit mehreren Tools, vergleiche Zeiträume, nenne konkrete Ursachen und 1–3 Empfehlungen. Handelnde Tools stehen nicht zur Verfügung – schlage Aktionen als Text vor.` :
  `Beantworte die Datenfrage mit den lesenden Tools. Handelnde Tools stehen nicht zur Verfügung.`}`;

// ---------- Hauptfunktion ----------
export async function handleChat(env: Env, body: { conversation_id?: string; message?: string; context?: any; force?: string }, ws = "default") {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, error: "ANTHROPIC_API_KEY fehlt im Worker" };
  const text = String(body.message ?? "").trim().slice(0, 4000);
  if (!text) return { ok: false, error: "leere Nachricht" };
  const ctx = body.context ?? {};
  let convId = body.conversation_id ? String(body.conversation_id) : "";
  if (convId && !(await db.first(env, "SELECT id FROM chat_conversations WHERE id = ? AND workspace_id = ?", convId, ws))) convId = "";
  if (!convId) { convId = rid(16); await db.run(env, "INSERT INTO chat_conversations (id, workspace_id, title, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", convId, ws, text.slice(0, 80), JSON.stringify(ctx), nowIso(), nowIso()); }
  await db.run(env, "INSERT INTO chat_messages (conversation_id, workspace_id, role, content, meta) VALUES (?, ?, 'user', ?, ?)", convId, ws, text, JSON.stringify({ context: ctx, force: body.force ?? null }));

  const budget = await chatBudget(env, ws);
  const { tier, how } = await route(env, text, body.force);
  const model = tier === "analysis" && !budget.exhausted ? strongModel(env) : fastModel(env);
  const tools = tier === "action" ? [...READ_TOOLS, ...ACT_TOOLS] : READ_TOOLS;
  // Verlauf (letzte 12 Nachrichten) als Kontext
  const hist = await db.all<any>(env, "SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 13", convId);
  const messages: any[] = hist.reverse().slice(0, -1).filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content.slice(0, 3000) }));
  messages.push({ role: "user", content: text.replace(/^analysiere\s*:\s*/i, "") });

  const sources: Record<string, number> = {}; let cost = 0; let proposal: any = null; let finalText = "";
  try {
    for (let step = 0; step < 7; step++) {
      const j = await anthropic(env, model, SYSTEM(env, tier, ctx, ws), messages, tools, tier === "analysis" ? 1600 : 1000);
      cost += usd(model, j.usage);
      const blocks: any[] = j.content ?? [];
      const textParts = blocks.filter((b) => b.type === "text").map((b) => b.text);
      const uses = blocks.filter((b) => b.type === "tool_use");
      if (!uses.length || j.stop_reason !== "tool_use") { finalText = textParts.join("\n").trim(); break; }
      messages.push({ role: "assistant", content: blocks });
      const results: any[] = [];
      for (const u of uses) {
        const def = TOOLS.find((t) => t.name === u.name);
        if (def?.kind === "act") {                                      // Vorschlag, nicht ausführen
          const id = rid(10), token = rid(24);
          const label = describeAction(u.name, u.input);
          await db.run(env, "INSERT INTO chat_actions (id, workspace_id, conversation_id, tool, args, label, token) VALUES (?, ?, ?, ?, ?, ?, ?)", id, ws, convId, u.name, JSON.stringify(u.input ?? {}), label, token);
          proposal = { id, tool: u.name, args: u.input ?? {}, label, confirm_token: token };
          results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify({ proposed: true, note: "Aktion wurde dem Nutzer zur Bestätigung vorgelegt, noch nicht ausgeführt." }) });
          continue;
        }
        const r = await runReadTool(env, u.name, u.input ?? {}, ws).catch((e) => ({ data: { error: String(e?.message ?? e) }, rows: 0 }));
        sources[u.name] = (sources[u.name] ?? 0) + r.rows;
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(r.data).slice(0, 12000) });
      }
      messages.push({ role: "user", content: results });
      if (proposal) {                                                   // nach dem Vorschlag noch eine kurze Erklärung holen
        const j2 = await anthropic(env, model, SYSTEM(env, tier, ctx, ws), messages, [], 400).catch(() => null);
        if (j2) { cost += usd(model, j2.usage); finalText = (j2.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim(); }
        break;
      }
    }
  } catch (e: any) {
    finalText = `Fehler bei der Anfrage: ${String(e?.message ?? e).slice(0, 200)}`;
  }
  await addUsage(env, ws, cost);
  if (!finalText) finalText = proposal ? `Vorschlag: ${proposal.label}` : "Keine Antwort erhalten.";
  const [answer, ...rest] = finalText.split(/\n-{3,}\n/);
  const reply = { text: answer.trim(), more: rest.join("\n---\n").trim() || null, sources: Object.entries(sources).map(([tool, rows]) => ({ tool, rows })), tier, how, model, usd: Math.round(cost * 10000) / 10000, action: proposal };
  await db.run(env, "INSERT INTO chat_messages (conversation_id, workspace_id, role, content, meta) VALUES (?, ?, 'assistant', ?, ?)", convId, ws, finalText, JSON.stringify({ ...reply, action: proposal ? { ...proposal, confirm_token: undefined } : null }));
  await db.run(env, "UPDATE chat_conversations SET updated_at = ? WHERE id = ?", nowIso(), convId);
  return { ok: true, conversation_id: convId, reply, budget: await chatBudget(env, ws) };
}

function describeAction(tool: string, a: any): string {
  switch (tool) {
    case "pause_account": return `Account ${String(a?.account).toUpperCase()} pausieren${a?.until ? ` bis ${a.until}` : ""}${a?.reason ? ` (${a.reason})` : ""}`;
    case "resume_account": return `Account ${String(a?.account).toUpperCase()} freigeben`;
    case "review_action": return `Clip ${String(a?.clip_id).slice(0, 8)}… ${a?.action === "approve" ? "freigeben" : a?.action === "reject" ? "ablehnen" : "neu rendern"}${a?.feedback ? ` – ${a.feedback}` : ""}`;
    case "update_settings": return `Einstellung ${a?.path} auf ${JSON.stringify(a?.value)} setzen${a?.niche ? ` (Nische ${a.niche})` : ""}`;
    case "move_slot": return `Post ${String(a?.post_id).slice(0, 8)}… auf ${a?.at} verschieben`;
    case "complete_task": return `Aufgabe ${a?.task_id} erledigen`;
    default: return `${tool} ${JSON.stringify(a)}`;
  }
}

/** Bestätigung im UI: Aktion ausführen (einmalig, Token muss passen). */
export async function confirmAction(env: Env, body: { action_id?: string; confirm_token?: string; cancel?: boolean }, ws = "default") {
  const a = await db.first<any>(env, "SELECT * FROM chat_actions WHERE id = ? AND workspace_id = ?", String(body.action_id ?? ""), ws);
  if (!a) return { ok: false, error: "Aktion nicht gefunden" };
  if (a.status !== "proposed") return { ok: false, error: `Aktion bereits ${a.status}` };
  if (body.cancel) { await db.run(env, "UPDATE chat_actions SET status = 'cancelled', executed_at = ? WHERE id = ?", nowIso(), a.id); return { ok: true, cancelled: true }; }
  if (String(body.confirm_token ?? "") !== a.token) return { ok: false, error: "Bestätigungs-Token ungültig" };
  let result: unknown;
  try { result = await runActTool(env, a.tool, JSON.parse(a.args), ws); }
  catch (e: any) { result = { ok: false, error: String(e?.message ?? e) }; }
  const ok = !!(result as any)?.ok || (!!result && !("error" in (result as any)));
  await db.run(env, "UPDATE chat_actions SET status = ?, result = ?, executed_at = ? WHERE id = ?", ok ? "confirmed" : "failed", JSON.stringify(result).slice(0, 4000), nowIso(), a.id);
  await db.run(env, "INSERT INTO chat_messages (conversation_id, workspace_id, role, content, meta) VALUES (?, ?, 'assistant', ?, ?)", a.conversation_id, ws, `${ok ? "✓ Ausgeführt" : "✗ Fehlgeschlagen"}: ${a.label}`, JSON.stringify({ tier: "action", executed: true, result }));
  await logEvent(env, `chat_action ${a.tool} ${ok ? "ok" : "failed"} ${a.label}`);
  return { ok, action: a.tool, label: a.label, result };
}

export async function listConversations(env: Env, ws = "default") {
  return db.all<any>(env, "SELECT id, title, context, created_at, updated_at FROM chat_conversations WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 30", ws);
}
export async function getConversation(env: Env, id: string, ws = "default") {
  const conv = await db.first<any>(env, "SELECT id, title, context, created_at, updated_at FROM chat_conversations WHERE id = ? AND workspace_id = ?", id, ws);
  if (!conv) return null;
  const rows = await db.all<any>(env, "SELECT id, role, content, meta, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id LIMIT 200", id);
  const actions = await db.all<any>(env, "SELECT id, tool, label, status, token FROM chat_actions WHERE conversation_id = ? ORDER BY created_at", id);
  return { ...conv, messages: rows.map((m) => { const meta = m.meta ? JSON.parse(m.meta) : {}; if (meta.action) { const act = actions.find((x) => x.id === meta.action.id); meta.action = act ? { ...meta.action, status: act.status, confirm_token: act.status === "proposed" ? act.token : undefined } : meta.action; } return { ...m, meta }; }), budget: await chatBudget(env, ws) };
}
