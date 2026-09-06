// Vorschläge (Nischen-Seite): Kandidaten aus RSS (neu erschienen) + Backlog (yt-dlp-Playlist: Titel, Dauer, Aufrufe).
// Ranking: neue Videos (< 30 Tage) zuerst, dann Backlog nach Aufrufen; bereits verwendete Videos und Videos unter der Mindestlänge
// der Nische (cut.min_s, Dauer unbekannt = zugelassen, Shorts nie) ausgeschlossen. „Nehmen" legt eine Quelle mit needs_download an
// (uploads-Zeile ohne Datei) + Aufgabe „Video herunterladen & hochladen"; der Upload in der Aufgabe hängt sich an diese Quelle.
// Automatik (runFan): fällt der Fan-Vorrat einer Nische unter stock_days (Feinjustierung, Standard 2), wird selbst gezogen –
// sichtbar im Workflow mit „automatisch gewählt", abbrechbar. Telegram informiert, fragt nicht.
// Seit dem Nachschub-Agenten kommen die Kandidaten aus catalog.ts: zwei Listen (frisch / Archiv), Sperrliste der schon
// verwendeten Videos und Stellen, und beim Selbstbefüllen die Mischung 70 % Archiv zu 30 % frisch.
import { Env, db, nowIso, logEvent, telegram, nichesOf } from "./shared";
import { getSettings } from "./settings";
import { completeTask } from "./tasks";
import { suggestionLists, pickForAgent } from "./catalog";
import { capacity } from "./probe";

export interface Suggestion { id: string; title: string; url: string; channel: string; duration_s: number | null; views: number; published_at: string | null; age_days: number | null; fresh: boolean; reason: string }

const yt = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const fmtViews = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(".", ",")} Mio` : v >= 1e3 ? `${Math.round(v / 1e3)} Tsd` : String(v));
const fmtDur = (s: number | null) => (s == null ? "Länge unbekannt" : `${Math.round(s / 60)} min`);

export async function listSuggestions(env: Env, niche: string, ws = "default", limit = 8): Promise<Suggestion[]> {
  const { fresh, archive } = await suggestionLists(env, niche, ws, limit);
  const mix = [...archive, ...fresh].slice(0, limit);               // eine Liste für Aufrufer, die nur eine erwarten (Archiv zuerst)
  return mix.map((c) => ({ id: c.id, title: c.title, url: c.url, channel: c.channel, duration_s: c.duration_s, views: c.views,
                           published_at: c.published_at, age_days: c.age_days, fresh: c.list === "fresh",
                           reason: `${c.list === "fresh" ? "Frisch" : "Archiv"} · ${fmtViews(c.views)} Aufrufe · ${fmtDur(c.duration_s)}${c.score != null ? ` · Bewertung ${c.score}` : ""}${c.account ? ` · passt zu ${c.account}` : ""}. ${c.reason}` }));
}

/** „Nehmen": Quelle mit needs_download + Aufgabe zum Herunterladen/Hochladen. auto = vom System gewählt. */
export async function pickSuggestion(env: Env, videoId: string, ws = "default", auto = false, list?: "fresh" | "archive"): Promise<{ ok: boolean; error?: string; upload_id?: string; task_id?: string }> {
  const v = await db.first<any>(env, "SELECT * FROM videos WHERE id = ? AND workspace_id = ?", videoId, ws);
  if (!v) return { ok: false, error: "Video nicht im Katalog" };
  const cap = await capacity(env, ws);                    // Obergrenze: ein Probelauf, zwei Videos in Produktion
  if (!cap.can_probe) return { ok: false, error: cap.reason ?? "Warteschlange voll" };
  const open = await db.first<any>(env, "SELECT id FROM uploads WHERE video_id = ? AND status NOT IN ('cancelled','error')", videoId);
  if (open) return { ok: false, error: "bereits gewählt" };
  const niche = v.niche_id ?? nichesOf(env).find((n) => Object.keys(n.channels ?? {}).includes(v.channel_id))?.key ?? nichesOf(env)[0]?.key ?? "mrbeast";
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await db.run(env,
    "INSERT INTO uploads (id, niche_id, key, title, size, kind, video_id, status, note, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'fan', ?, 'needs_download', ?, ?, ?, ?)",
    id, niche, `pending/${niche}/${id}`, String(v.title ?? videoId).slice(0, 120), videoId,
    auto ? `automatisch gewählt${list ? ` (${list === "archive" ? "Archiv" : "frisch"})` : ""}` : null, ws, nowIso(), nowIso());
  await db.run(env, "UPDATE videos SET status = 'picked', updated_at = ? WHERE id = ?", nowIso(), videoId);
  const taskId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const nl = nichesOf(env).find((n) => n.key === niche)?.label ?? niche;
  await db.run(env,
    "INSERT INTO tasks (id, workspace_id, kind, ref, title, detail, niche, urls, auto_check, created_at) VALUES (?, ?, 'footage', ?, ?, ?, ?, ?, 1, ?)",
    taskId, ws, `dl:${videoId}`, `Video herunterladen & hochladen: ${String(v.title ?? videoId).slice(0, 80)}`,
    `${v.channel_name ?? ""} · ${fmtViews(v.views ?? 0)} Aufrufe · ${fmtDur(v.duration_s ?? null)}${auto ? " · automatisch gewählt (Vorrat unter Soll)" : ""} · Nische ${nl}`,
    niche, JSON.stringify([v.url ?? yt(videoId)]), nowIso());
  await logEvent(env, `source_picked video=${videoId} niche=${niche}${auto ? " auto" : ""}`);
  if (auto) await telegram(env, `📦 Fan-Vorrat für ${nl} unter Soll – automatisch gewählt:\n${v.channel_name ?? ""}: ${v.title}\n${v.url ?? yt(videoId)}\n→ Dashboard → Aufgaben: herunterladen und in der Aufgabe hochladen (oder dort abbrechen).`);
  return { ok: true, upload_id: id, task_id: taskId };
}

/** Auswahl abbrechen: Quelle verwerfen, Video zurück in den Katalog, Aufgabe erledigen. */
export async function cancelPick(env: Env, uploadId: string, ws = "default"): Promise<{ ok: boolean; error?: string }> {
  const u = await db.first<any>(env, "SELECT * FROM uploads WHERE id = ? AND workspace_id = ? AND status = 'needs_download'", uploadId, ws);
  if (!u) return { ok: false, error: "keine offene Auswahl" };
  await db.run(env, "UPDATE uploads SET status = 'cancelled', updated_at = ? WHERE id = ?", nowIso(), uploadId);
  if (u.video_id) await db.run(env, "UPDATE videos SET status = 'new', updated_at = ? WHERE id = ? AND status = 'picked'", nowIso(), u.video_id);
  const t = await db.first<{ id: string }>(env, "SELECT id FROM tasks WHERE workspace_id = ? AND kind = 'footage' AND ref = ? AND done = 0", ws, `dl:${u.video_id}`);
  if (t) await completeTask(env, t.id, "auto");
  await logEvent(env, `source_cancelled upload=${uploadId} video=${u.video_id ?? "-"}`);
  return { ok: true };
}

/** Automatik: je Nische Vorrat in Tagen (fertige Fan-Clips ÷ Tageslimit, Minimum über die Accounts) gegen stock_days prüfen. */
export async function autoPick(env: Env, stock: Record<string, { ready: number; target: number }>, ws = "default"): Promise<{ picked: string[]; days: Record<string, number> }> {
  const s = await getSettings(env, ws);
  const stockDaysEnv = Number(env.STOCK_DAYS || 3);
  const out = { picked: [] as string[], days: {} as Record<string, number> };
  for (const n of nichesOf(env)) {
    const threshold = Number(s.niches[n.key]?.stock_days ?? 2);
    const per = n.accounts.map((a) => stock[a]).filter(Boolean);
    const days = per.length ? Math.min(...per.map((x) => (x.target ? (x.ready * stockDaysEnv) / x.target : 0))) : 99;
    out.days[n.key] = Math.round(days * 10) / 10;
    if (days >= threshold) continue;
    const inflight = await db.first<{ n: number }>(env,
      "SELECT COUNT(*) AS n FROM uploads WHERE workspace_id = ? AND niche_id = ? AND status IN ('needs_download','uploading','uploaded','dispatched') AND updated_at >= ?",
      ws, n.key, new Date(Date.now() - 48 * 3600000).toISOString());
    if (inflight?.n) continue;                                   // schon etwas unterwegs (gewählt/lädt/Clip-Job läuft)
    const top = await pickForAgent(env, n.key, ws);               // Mischung 70 % Archiv, 30 % frisch
    if (!top) { await logEvent(env, `stock_low niche=${n.key} days=${out.days[n.key]} keine Vorschläge`); continue; }
    const r = await pickSuggestion(env, top.id, ws, true, top.list);
    if (r.ok) out.picked.push(top.id);
  }
  return out;
}
