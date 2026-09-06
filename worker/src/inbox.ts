// Benachrichtigungszentrale (Nachtrag 2): jede Telegram-Nachricht wird zusätzlich in `notifications` gespiegelt (je Workspace),
// mit Ereignistyp (aus Emoji/Text abgeleitet), Gelesen/Erledigt und Regeln je Ereignistyp (Telegram an/aus; Push folgt mit der PWA).
// Seite #inbox: Tiefe 1 = ungelesene Einträge (Typ, Zeit, erste Zeile), Tiefe 2 = ganzer Text, „Erklären" → Chat-Deep-Link.
import { Env, db, nowIso } from "./shared";

export type NotifKind = "report" | "supply" | "new_video" | "upload" | "clip_job" | "submit" | "preview" | "warning" | "error" | "killswitch" | "test" | "info";
export const NOTIF_KINDS: Record<NotifKind, string> = {
  report: "Berichte", supply: "Nachschub", new_video: "Neue Videos", upload: "Uploads", clip_job: "Clip-Jobs", submit: "Einreichen",
  preview: "Vorschauen", warning: "Warnungen", error: "Fehler", killswitch: "Kill-Switch", test: "Tests", info: "Sonstiges",
};
const RULES: [NotifKind, RegExp][] = [
  ["killswitch", /kill.?switch|pausiert|paused|freigegeben|account_resumed/i],
  ["error", /❌|fehler|error|failed|fehlgeschlagen/i],
  ["warning", /⚠|warnung|>24 h|ohne clip-job|unter soll/i],
  ["report", /📊|wochenbericht|tagesübersicht|wochenreport/i],
  ["supply", /📦|nachschub|vorrat|automatisch gewählt/i],
  ["new_video", /🎬|neues video/i],
  ["upload", /📥|hochgeladen|upload/i],
  ["clip_job", /✂|clip-job|schnitt fertig|rohclips/i],
  ["submit", /📎|einreichen|eingereicht|vyro/i],
  ["preview", /🖼|cover|vorschau|standbild/i],
  ["test", /🧪|test/i],
];
export const classify = (text: string): NotifKind => RULES.find(([, re]) => re.test(text))?.[0] ?? "info";

export interface NotifRules { [kind: string]: { telegram: boolean; push: boolean } }
export async function getRules(env: Env, ws = "default"): Promise<NotifRules> {
  const r = await db.first<{ value: string }>(env, "SELECT value FROM kv WHERE key = ?", `notify_rules:${ws}`);
  const stored = (() => { try { return r ? (JSON.parse(r.value) as NotifRules) : {}; } catch { return {}; } })();
  const out: NotifRules = {};
  for (const k of Object.keys(NOTIF_KINDS)) out[k] = { telegram: stored[k]?.telegram ?? true, push: stored[k]?.push ?? false };
  return out;
}
export async function putRules(env: Env, rules: NotifRules, ws = "default"): Promise<NotifRules> {
  const cur = await getRules(env, ws);
  for (const [k, v] of Object.entries(rules ?? {})) if (cur[k] && v && typeof v === "object") cur[k] = { telegram: !!(v as any).telegram, push: !!(v as any).push };
  await db.run(env, "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", `notify_rules:${ws}`, JSON.stringify(cur), nowIso());
  return cur;
}

/** Nachricht spiegeln; Rückgabe: ob Telegram laut Regel senden soll. Scheitert nie hart (Telegram darf nicht blockieren). */
export async function recordNotification(env: Env, text: string, photoUrl: string | null = null, kind?: NotifKind): Promise<{ id: number | null; telegram: boolean; kind: NotifKind }> {
  const ws = env.WS ?? "default";
  const k = kind ?? classify(text);
  let telegram = true;
  try {
    const rules = await getRules(env, ws);
    telegram = rules[k]?.telegram ?? true;
    const title = text.split("\n").find((l) => l.trim())?.slice(0, 140) ?? "(ohne Text)";
    const r = await db.run(env, "INSERT INTO notifications (workspace_id, kind, title, text, photo_url, sent_telegram) VALUES (?, ?, ?, ?, ?, ?)", ws, k, title, text.slice(0, 4000), photoUrl, telegram ? 1 : 0);
    return { id: (r as any)?.meta?.last_row_id ?? null, telegram, kind: k };
  } catch (e: any) {
    console.log("[inbox] record", e?.message ?? e);
    return { id: null, telegram, kind: k };
  }
}

export async function listInbox(env: Env, opts: { filter?: string; kind?: string; limit?: number; before?: number }, ws = "default") {
  const limit = Math.min(200, Math.max(10, Number(opts.limit) || 40));
  const where = ["workspace_id = ?"]; const args: unknown[] = [ws];
  if (opts.filter === "unread") where.push("read = 0 AND done = 0");
  else if (opts.filter === "open") where.push("done = 0");
  else if (opts.filter === "done") where.push("done = 1");
  if (opts.kind && opts.kind !== "all") { where.push("kind = ?"); args.push(opts.kind); }
  if (opts.before) { where.push("id < ?"); args.push(Number(opts.before)); }
  const items = await db.all<any>(env, `SELECT id, kind, title, text, photo_url, sent_telegram, read, done, created_at FROM notifications WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...args, limit);
  const c = await db.first<any>(env, "SELECT SUM(read = 0 AND done = 0) AS unread, SUM(done = 0) AS open, COUNT(*) AS total FROM notifications WHERE workspace_id = ?", ws);
  const byKind = await db.all<any>(env, "SELECT kind, COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND done = 0 GROUP BY kind", ws);
  const counts: Record<string, number> = { unread: Number(c?.unread ?? 0), open: Number(c?.open ?? 0), total: Number(c?.total ?? 0) };
  for (const r of byKind) counts[r.kind] = Number(r.n);
  return { items: items.map((i) => ({ ...i, read: !!i.read, done: !!i.done, sent_telegram: !!i.sent_telegram, explain: `Erkläre: ${i.title}` })), counts, kinds: NOTIF_KINDS, next_before: items.length >= limit ? items[items.length - 1].id : null };
}

export async function markNotification(env: Env, id: number | "all", action: "read" | "done" | "unread" | "reopen", ws = "default") {
  const set = action === "read" ? "read = 1" : action === "unread" ? "read = 0" : action === "done" ? "done = 1, read = 1" : "done = 0";
  if (id === "all") { await db.run(env, `UPDATE notifications SET ${set} WHERE workspace_id = ? AND done = 0`, ws); return { ok: true, all: true }; }
  const r = await db.run(env, `UPDATE notifications SET ${set} WHERE workspace_id = ? AND id = ?`, ws, Number(id));
  return { ok: ((r as any)?.meta?.changes ?? 1) > 0, id: Number(id) };
}
