// Chat-Analyse für Jobs (Nachtrag 7): das starke Modell fasst den Wochenbericht zusammen (3 Sätze) und schlägt 3 bestätigbare
// Aktionen vor; der tägliche Anomalie-Check meldet Auffälligkeiten in die Benachrichtigungszentrale mit „Erklären"-Link in den Chat.
// Beide Jobs laufen über dieselben Tools wie der Chat (Zahlen nur aus Tool-Ergebnissen) und respektieren das Tagesbudget.
import { Env, db, nowIso, telegram, logEvent } from "./shared";
import { buildWeeklyReport, saveWeeklyReport, WeeklyReport } from "./report";
import { accountHealth } from "./health";
import { accountsOf } from "./publisher";
import { fanStock } from "./fan";
import { chatBudget, handleChat } from "./chat";
import { recordNotification } from "./inbox";

const ACTION_TOOLS: Record<string, string> = {
  pause_account: "Account pausieren", resume_account: "Account freigeben", update_settings: "Einstellung ändern",
  review_action: "Clip freigeben/ablehnen", move_slot: "Post verschieben", complete_task: "Aufgabe erledigen",
};

/** Wochenbericht durch das starke Modell: 3 Sätze + bis zu 3 Vorschläge (als Chat-Aktionen bestätigbar). */
export async function weeklyInsight(env: Env, rep: WeeklyReport, ws = "default"): Promise<{ summary: string[]; suggestions: WeeklyReport["suggestions"]; conversation_id?: string } | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  const budget = await chatBudget(env, ws);
  if (budget.exhausted) return null;
  const prompt = `Analysiere: Erstelle den Wochenbericht für ${rep.week}. Hole dir die Zahlen mit den Tools (Report, Accounts, Health, A/B, Auszahlungen, Aufgaben).
Antworte in genau diesem Format:
Zeile 1–3: drei kurze Sätze zur Woche (Zahlen zuerst, jeweils ein Satz).
Dann eine Zeile "---".
Danach höchstens drei Vorschläge, je einer pro Zeile, beginnend mit "* ". Jeder Vorschlag ist eine konkrete Handlung, die im Dashboard bestätigt werden kann.`;
  const r = await handleChat(env, { message: prompt, context: { page: "report", job: "weekly" }, force: "analysis" }, ws).catch(() => null);
  if (!r?.ok || !r.reply) return null;
  const all = [r.reply.text, r.reply.more].filter(Boolean).join("\n");
  const lines = all.split("\n").map((l) => l.trim()).filter(Boolean);
  let summary = lines.filter((l) => !l.startsWith("*") && !l.startsWith("-") && !/^-{3,}$/.test(l)).slice(0, 3);
  if (summary.length === 1 && summary[0].length > 160)                            // Modell hat einen Absatz geliefert → in Sätze zerlegen
    summary = summary[0].split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9])/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
  const suggestions = lines.filter((l) => /^[*-]\s/.test(l)).slice(0, 3).map((l) => ({ text: l.replace(/^[*-]\s*/, ""), action: { kind: "chat", label: "Im Chat besprechen", href: `#chat:${encodeURIComponent(l.replace(/^[*-]\s*/, ""))}` } }));
  return { summary: summary.length ? summary : rep.summary, suggestions: suggestions.length ? suggestions : rep.suggestions, conversation_id: r.conversation_id };
}

/** Sonntags 09:00 Berlin: Bericht bauen, vom starken Modell zusammenfassen lassen, speichern, Telegram-Kurzfassung. */
export async function runWeeklyReportAI(env: Env, force = false, ws = "default") {
  if (!force && new Date().getUTCDay() !== 0) return { skipped: "nicht Sonntag" };
  const rep = await buildWeeklyReport(env, "current", ws);
  const ai = await weeklyInsight(env, rep, ws);
  if (ai) { rep.summary = ai.summary; rep.suggestions = ai.suggestions; (rep as any).by = "analysis"; }
  await saveWeeklyReport(env, rep, ws);
  const dash = env.DASHBOARD_URL || "https://clipforge-dashboard-bh8.pages.dev";
  const L = [`📊 Wochenbericht ${rep.week}`, ...rep.summary, "", "Vorschläge:", ...rep.suggestions.map((s, i) => `${i + 1}. ${s.text}`), "", `Details: ${dash}/#report`];
  await telegram(env, L.join("\n"));
  await logEvent(env, `weekly_report ${rep.week} ai=${ai ? "ja" : "nein"}`);
  return { week: rep.week, ai: !!ai, posts: rep.totals.posts, views: rep.totals.views };
}

export interface Anomaly { key: string; severity: "warn" | "alert"; title: string; detail: string; question: string }

/** Täglicher Anomalie-Check aus echten Daten (ohne Modell): Ampel rot, kein Post, Vorrat leer, Fehler-Häufung, Einreichrückstand. */
export async function detectAnomalies(env: Env, ws = "default"): Promise<Anomaly[]> {
  const out: Anomaly[] = [];
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  for (const id of Object.keys(accountsOf(env))) {
    const h = await accountHealth(env, id, ws).catch(() => null);
    if (h?.color === "red") out.push({ key: `health:${id}`, severity: "alert", title: `Account ${id}: ${h.headline}`, detail: h.reasons.join(" "), question: h.question });
    else if (h?.color === "yellow" && (h.metrics.trend_pct ?? 0) <= -30) out.push({ key: `trend:${id}`, severity: "warn", title: `Account ${id}: Views fallen`, detail: h.reasons.join(" "), question: h.question });
  }
  const errs = await db.all<{ event: string }>(env, "SELECT event FROM events WHERE workspace_id = ? AND at >= ? AND (event LIKE '%error%' OR event LIKE '%failed%' OR event LIKE 'footage_missing%')", ws, since);
  const real = errs.filter((e) => !/^cron \w+ ok/.test(e.event) && !/"errors?":\s*0/.test(e.event));
  if (real.length >= 3) out.push({ key: "errors", severity: "warn", title: `${real.length} Fehler in 24 Stunden`, detail: real.slice(0, 3).map((e) => e.event.slice(0, 80)).join(" · "), question: "Welche Fehler gab es in den letzten 24 Stunden und was ist die Ursache?" });
  const pending = await db.first<any>(env, "SELECT COUNT(*) AS n FROM posts WHERE workspace_id = ? AND status = 'posted' AND submitted_at IS NULL AND post_url IS NOT NULL AND posted_at < ?", ws, new Date(Date.now() - 48 * 3600000).toISOString());
  if ((pending?.n ?? 0) >= 5) out.push({ key: "submit", severity: "warn", title: `${pending.n} Posts seit über 48 Stunden nicht eingereicht`, detail: "Ohne Einreichung bei Vyro gibt es keine Auszahlung.", question: "Welche Posts sind noch nicht bei Vyro eingereicht?" });
  try {
    const stock = await fanStock(env), stockDays = Number(env.STOCK_DAYS || 3);
    for (const [acc, s] of Object.entries(stock as Record<string, { ready: number; target: number }>)) {
      const days = s.target ? (s.ready * stockDays) / s.target : 0;
      if (days < 1) { out.push({ key: `stock:${acc}`, severity: "warn", title: `Fan-Vorrat für ${acc} fast leer`, detail: `Reicht noch ${days.toFixed(1)} Tage (${s.ready}/${s.target} Clips).`, question: `Warum ist der Fan-Vorrat für ${acc} leer und was ist zu tun?` }); break; }
    }
  } catch { /* optional */ }
  return out;
}

/** Täglich: Anomalien erkennen, je Anomalie höchstens einmal in 24 h in den Posteingang (mit „Erklären"-Link). */
export async function runAnomalyCheck(env: Env, ws = "default") {
  const found = await detectAnomalies(env, ws);
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  let sent = 0;
  for (const a of found) {
    const seen = await db.first<any>(env, "SELECT id FROM events WHERE workspace_id = ? AND event = ? AND at >= ?", ws, `anomaly ${a.key}`, since);
    if (seen) continue;
    await db.run(env, "INSERT INTO events (campaign_id, event, workspace_id) VALUES (NULL, ?, ?)", `anomaly ${a.key}`, ws);
    await recordNotification(env, `${a.severity === "alert" ? "❌" : "⚠️"} ${a.title}\n${a.detail}\nErklären: ${(env.DASHBOARD_URL || "https://clipforge-dashboard-bh8.pages.dev")}/#chat:${encodeURIComponent(a.question)}`, null, a.severity === "alert" ? "error" : "warning");
    sent++;
  }
  await db.run(env, "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
               `anomalies:${ws}`, JSON.stringify({ at: nowIso(), found }), nowIso());
  return { found: found.length, notified: sent, keys: found.map((f) => f.key) };
}

export async function lastAnomalies(env: Env, ws = "default") {
  const r = await db.first<{ value: string }>(env, "SELECT value FROM kv WHERE key = ?", `anomalies:${ws}`);
  try { return r ? JSON.parse(r.value) : { at: null, found: [] }; } catch { return { at: null, found: [] }; }
}
void ACTION_TOOLS;
