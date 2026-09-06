// Ereignis-Log (Stufe 5): events-Tabelle mit abgeleiteter Kategorie (Fehler, Ablehnungen, Kill-Switch, Uploads, Posts, Jobs, Einstellungen),
// Suche, Paginierung und Link zum GitHub-Actions-Lauf (run=<id> im Ereignistext, sonst Workflow-Liste).
import { Env, db } from "./shared";

export type LogCat = "error" | "reject" | "killswitch" | "upload" | "post" | "job" | "settings" | "pacer" | "other";
export const LOG_CATS: Record<LogCat, string> = { error: "Fehler", reject: "Ablehnungen", killswitch: "Kill-Switch", upload: "Uploads", post: "Posts", job: "Clip-Jobs", settings: "Einstellungen", pacer: "Taktgeber", other: "Sonstiges" };

const RULES: [LogCat, RegExp][] = [
  ["pacer", /^pacer /],                       // Taktgeber-Vorschläge zuerst: sie nennen Pausen und Vorrat, wären sonst „Kill-Switch"
  ["error", /error|fehler|failed|fehlgeschlagen|exception|traceback|_missing|dispatch_failed/i],
  ["reject", /reject|abgelehnt|verworfen|rejected_/i],
  ["killswitch", /kill.?switch|pausiert|paused|account_resumed|account_rules|freigegeben|views_drop/i],
  ["upload", /upload|footage|backlog|rss_check|stock_low|nachschub|kind=footage/i],
  ["post", /publish|veröffentlicht|posted|scheduled|geplant|shadow|schatten|submitted|eingereicht|vyro_submit|go_live|kind=submit|review approve/i],
  ["job", /clip_job|clip-job|stage=|schnitt|clipper|pipeline_done|rohclips|transkript|momentwahl/i],
  ["settings", /settings_|ab_|kv_set|campaign_patch|task_created|task_done/i],
];
export const categorize = (text: string): LogCat => {
  const t = text.replace(/"errors?"\s*:\s*0/gi, "").replace(/\berrors?=0\b/gi, "");   // "errors":0 in Cron-Heartbeats ist kein Fehler
  if (/^cron \w+ ok\b/.test(t)) return "other";
  return RULES.find(([, re]) => re.test(t))?.[0] ?? "other";
};

export interface LogItem { id: number; at: string; campaign_id: string | null; text: string; cat: LogCat; run_id: string | null }

export async function listLog(env: Env, opts: { cat?: string; q?: string; limit?: number; before?: number }, ws = "default"): Promise<{ items: LogItem[]; counts: Record<string, number>; repo: string | null; next_before: number | null }> {
  const limit = Math.min(200, Math.max(10, Number(opts.limit) || 60));
  const where: string[] = ["workspace_id = ?"]; const args: unknown[] = [ws];
  if (opts.before) { where.push("id < ?"); args.push(Number(opts.before)); }
  if (opts.q) { where.push("(event LIKE ? OR campaign_id LIKE ?)"); args.push(`%${opts.q}%`, `%${opts.q}%`); }
  // Kategorie wird im Worker abgeleitet → bei Filter mehr Zeilen lesen und danach filtern
  const rows = await db.all<{ id: number; campaign_id: string | null; event: string; at: string }>(env,
    `SELECT id, campaign_id, event, at FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...args, opts.cat && opts.cat !== "all" ? limit * 8 : limit * 2);
  let items: LogItem[] = rows.map((r) => ({ id: r.id, at: r.at, campaign_id: r.campaign_id, text: r.event, cat: categorize(r.event), run_id: (/\brun=(\d{6,})\b/.exec(r.event) ?? [])[1] ?? null }));
  if (opts.cat && opts.cat !== "all") items = items.filter((i) => i.cat === opts.cat).slice(0, limit);
  else if (!opts.q) items = items.filter((i) => !/^cron \w+ ok\b/.test(i.text));          // Heartbeats nur unter „Sonstiges" oder per Suche (automatisch Erledigtes nicht zeigen)
  const counts: Record<string, number> = {};
  const recent = await db.all<{ event: string }>(env, "SELECT event FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT 500", ws);
  for (const r of recent) { const c = categorize(r.event); counts[c] = (counts[c] ?? 0) + 1; }
  counts.all = recent.filter((r) => !/^cron \w+ ok\b/.test(r.event)).length;
  items = items.slice(0, limit);
  return { items, counts, repo: env.GITHUB_REPO ?? null, next_before: rows.length >= limit && items.length ? items[items.length - 1].id : null };
}
