// Nachschub-Agent mit Archiv: Katalog bewerten, zwei Vorschlagslisten (frisch / Archiv), Sperrliste der verwendeten Stellen.
//
// Katalog: die Tabelle videos ist der vollständige Katalog der vier Kanäle (einmalig per scripts/yt_backlog.py --limit 0
// eingelesen, danach trägt RSS nur noch neue Videos nach). „sources" heißt im System weiterhin die Upload-Zeile, deshalb
// bleibt der Katalog in videos – zwei Katalogtabellen wären zwei Wahrheiten.
//
// Bewertung: das schnelle Modell bewertet je Video aus Titel, Kanal, Dauer, Alter und Aufrufen:
//   moments (wie viele klippbare Momente zu erwarten sind), fit_a (krasse Momente → Account A),
//   fit_b (Crew-Reaktionen → Account B), quality (Bildqualität nach Alter), overclipped (wirkt totgeklippt).
// Daraus wird score (0–10). Das Archiv-Ranking ist Aufrufe × score.
//
// Sperrliste: video_usage hält jede verwendete Stelle mit Zeitstempel. Kein Video zweimal in 90 Tagen,
// nie dieselbe Stelle zweimal (Überschneidung zählt schon als dieselbe Stelle).
import { Env, db, nowIso, logEvent, nichesOf } from "./shared";
import { getSettings } from "./settings";
import { askModel } from "./chat";

export const REUSE_BLOCK_DAYS = 90;          // dasselbe Quellvideo frühestens nach 90 Tagen wieder
export const SEGMENT_PAD_S = 5;              // Stellen gelten als gleich, wenn sie sich (mit Puffer) überschneiden
export const ARCHIVE_MIN_AGE_DAYS = 182;     // „älter als 6 Monate"
export const FRESH_MAX_AGE_DAYS = 14;        // „letzte 14 Tage"
export const ARCHIVE_SHARE = 0.7;            // Standardmischung, wenn der Agent selbst befüllt: 70 % Archiv
export const MIN_HEIGHT = 480;               // darunter aussortieren (Regel für alte Videos)

const yt = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const fmtViews = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(".", ",")} Mio` : v >= 1e3 ? `${Math.round(v / 1e3)} Tsd` : String(v));
const fmtDur = (s: number | null) => (s == null ? "Länge unbekannt" : `${Math.round(s / 60)} min`);
const ageDays = (iso: string | null) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000)) : null);

export interface Rating { moments: number; fit_a: number; fit_b: number; quality: number; overclipped: boolean; note: string }
export interface Candidate {
  id: string; title: string; url: string; channel: string; duration_s: number | null; views: number;
  published_at: string | null; age_days: number | null; list: "fresh" | "archive";
  score: number | null; fit_a: number | null; fit_b: number | null; account: "A" | "B" | null;
  rank_value: number; height: number | null; reason: string;
}

// ---------- Bewertung ----------

const RATE_SYSTEM = `Du bewertest YouTube-Videos der MrBeast-Kanäle als Quellmaterial für TikTok-Clips.
Account A postet krasse Momente (Stunts, Geld, Gefahr, Rekorde), Account B postet Crew-Reaktionen (Gesichter, Streit, Freude, Kommentare).
Antworte ausschließlich mit einer JSON-Liste, ein Objekt je Video, in derselben Reihenfolge:
[{"id":"<id>","moments":0-10,"fit_a":0-10,"fit_b":0-10,"quality":0-10,"overclipped":true|false,"note":"<ein kurzer Satz>"}]
moments = wie viele klippbare Momente das Video erwarten lässt. quality = erwartete Bildqualität nach Alter
(vor 2019 oft 720p oder weniger, das drückt den Wert). overclipped = true, wenn das Video so bekannt ist,
dass es auf TikTok längst totgeklippt wirkt.`;

/** Bis zu `limit` unbewertete Videos vom schnellen Modell bewerten lassen (Tagesbudget des Chats gilt). */
export async function rateVideos(env: Env, limit = 20, ws = "default") {
  const rows = await db.all<any>(env,
    `SELECT id, title, channel_name, duration_s, views, published_at FROM videos
     WHERE workspace_id = ? AND rated_at IS NULL AND COALESCE(is_short,0) = 0 AND status IN ('new','picked')
     ORDER BY views DESC LIMIT ?`, ws, Math.max(1, Math.min(60, limit)));
  if (!rows.length) return { rated: 0, remaining: 0, note: "nichts offen" };
  let rated = 0;
  for (let i = 0; i < rows.length; i += 10) {                       // in Zehnerblöcken, das hält die Antwort klein und billig
    const batch = rows.slice(i, i + 10);
    const list = batch.map((v) => ({ id: v.id, titel: v.title, kanal: v.channel_name, minuten: v.duration_s ? Math.round(v.duration_s / 60) : null,
                                     jahr: v.published_at ? v.published_at.slice(0, 4) : null, aufrufe: v.views ?? 0 }));
    const text = await askModel(env, JSON.stringify(list), { system: RATE_SYSTEM, maxTokens: 1200, ws }).catch(() => null);
    if (!text) break;                                               // kein Schlüssel oder Budget aufgebraucht
    let parsed: any[] = [];
    try { parsed = JSON.parse((/\[[\s\S]*\]/.exec(text) ?? [text])[0]); } catch { parsed = []; }
    for (const v of batch) {
      const r = parsed.find((x: any) => String(x?.id) === v.id);
      if (!r) continue;
      const num = (x: any, d = 5) => Math.max(0, Math.min(10, Number.isFinite(Number(x)) ? Number(x) : d));
      const rating: Rating = { moments: num(r.moments), fit_a: num(r.fit_a), fit_b: num(r.fit_b), quality: num(r.quality),
                               overclipped: !!r.overclipped, note: String(r.note ?? "").slice(0, 200) };
      const score = Math.round(((rating.moments * 0.45 + Math.max(rating.fit_a, rating.fit_b) * 0.35 + rating.quality * 0.2)
                                * (rating.overclipped ? 0.5 : 1)) * 10) / 10;
      await db.run(env,
        "UPDATE videos SET rating = ?, score = ?, fit_a = ?, fit_b = ?, overclipped = ?, rated_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
        JSON.stringify(rating), score, rating.fit_a, rating.fit_b, rating.overclipped ? 1 : 0, nowIso(), nowIso(), v.id, ws);
      rated++;
    }
  }
  const rest = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM videos WHERE workspace_id = ? AND rated_at IS NULL AND COALESCE(is_short,0) = 0 AND status IN ('new','picked')", ws);
  if (rated) await logEvent(env, `catalog_rated ${rated} Videos bewertet, offen ${rest?.n ?? 0}`);
  return { rated, remaining: rest?.n ?? 0 };
}

// ---------- Sperrliste ----------

/** Verwendete Stelle eines Quellvideos festhalten (aus der Pipeline beim Anlegen eines Clips). */
export async function recordUsage(env: Env, u: { video_id: string; clip_id?: string | null; account?: string | null; start_s?: number | null; end_s?: number | null; note?: string | null }, ws = "default") {
  if (!u.video_id) return { ok: false, error: "video_id fehlt" };
  await db.run(env, "INSERT INTO video_usage (workspace_id, video_id, clip_id, account, start_s, end_s, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
               ws, u.video_id, u.clip_id ?? null, u.account ?? null, u.start_s ?? null, u.end_s ?? null, u.note ?? null);
  return { ok: true };
}

/** Videos, die innerhalb der Sperrfrist schon verwendet wurden. */
export async function blockedVideoIds(env: Env, ws = "default", days = REUSE_BLOCK_DAYS): Promise<Set<string>> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await db.all<{ video_id: string }>(env, "SELECT DISTINCT video_id FROM video_usage WHERE workspace_id = ? AND used_at >= ?", ws, since);
  return new Set(rows.map((r) => r.video_id));
}

/** Schon verwendete Stellen eines Videos – unabhängig vom Alter, dieselbe Stelle nie zweimal. */
export async function usedSegments(env: Env, videoId: string, ws = "default"): Promise<{ start_s: number | null; end_s: number | null; used_at: string }[]> {
  return db.all<any>(env, "SELECT start_s, end_s, used_at FROM video_usage WHERE workspace_id = ? AND video_id = ? ORDER BY used_at DESC", ws, videoId);
}

/** Überschneidet sich eine Stelle mit einer schon verwendeten? (Puffer, damit „fast dieselbe" auch zählt.) */
export async function segmentTaken(env: Env, videoId: string, start: number, end: number, ws = "default"): Promise<boolean> {
  const segs = await usedSegments(env, videoId, ws);
  return segs.some((s) => s.start_s != null && s.end_s != null && start < Number(s.end_s) + SEGMENT_PAD_S && end > Number(s.start_s) - SEGMENT_PAD_S);
}

// ---------- Vorschlagslisten ----------

async function candidates(env: Env, niche: string, ws: string): Promise<any[]> {
  const n = nichesOf(env).find((x) => x.key === niche);
  if (!n) return [];
  const s = await getSettings(env, ws);
  const minS = Number(s.niches[niche]?.cut?.min_s ?? 15);
  const minSource = Math.max(180, minS * 4);                        // Quelle muss deutlich länger als ein Clip sein
  const channelIds = Object.keys(n.channels ?? {});
  return db.all<any>(env,
    `SELECT v.id, v.title, v.url, v.channel_name, v.duration_s, v.views, v.published_at, v.height, v.score, v.fit_a, v.fit_b, v.rating, v.overclipped
     FROM videos v
     WHERE v.workspace_id = ? AND (v.niche_id = ? ${channelIds.length ? `OR v.channel_id IN (${channelIds.map(() => "?").join(",")})` : ""})
       AND v.status = 'new' AND COALESCE(v.is_short, 0) = 0 AND v.campaign_id IS NULL
       AND (v.duration_s IS NULL OR v.duration_s >= ?)
       AND (v.height IS NULL OR v.height >= ?)
       AND COALESCE(v.overclipped, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.video_id = v.id AND u.status NOT IN ('cancelled','error'))`,
    ws, niche, ...channelIds, minSource, MIN_HEIGHT);
}

const toCandidate = (v: any, list: "fresh" | "archive", rank: number): Candidate => {
  const age = ageDays(v.published_at);
  const score = v.score == null ? null : Number(v.score);
  const fitA = v.fit_a == null ? null : Number(v.fit_a), fitB = v.fit_b == null ? null : Number(v.fit_b);
  const account = fitA == null || fitB == null ? null : fitA >= fitB ? "A" : "B";
  let rating: Rating | null = null;
  try { rating = v.rating ? JSON.parse(v.rating) : null; } catch { rating = null; }
  // Begründung ohne Zahlen: die stehen als eigene Felder daneben (Dashboard und Telegram zeigen sie getrennt)
  const reason = (list === "fresh" ? "Aktuelle Aufmerksamkeit, dafür viel Konkurrenz." : "Wenig Konkurrenz, hohe Gesamtaufrufe.")
    + (score != null ? "" : " Noch nicht bewertet.") + (rating?.note ? ` ${rating.note}` : "");
  return { id: v.id, title: v.title ?? v.id, url: v.url ?? yt(v.id), channel: v.channel_name ?? "", duration_s: v.duration_s ?? null,
           views: v.views ?? 0, published_at: v.published_at ?? null, age_days: age, list, score, fit_a: fitA, fit_b: fitB, account,
           rank_value: Math.round(rank), height: v.height ?? null, reason };
};

/** Zwei Listen: frisch (letzte 14 Tage, neueste zuerst) und Archiv (älter als 6 Monate, Aufrufe × Bewertung). */
export async function suggestionLists(env: Env, niche: string, ws = "default", limit = 8): Promise<{ fresh: Candidate[]; archive: Candidate[]; blocked: number; unrated: number }> {
  const rows = await candidates(env, niche, ws);
  const blocked = await blockedVideoIds(env, ws);
  const open = rows.filter((v) => !blocked.has(v.id));
  const freshCut = Date.now() - FRESH_MAX_AGE_DAYS * 86400000, archiveCut = Date.now() - ARCHIVE_MIN_AGE_DAYS * 86400000;
  const t = (v: any) => (v.published_at ? new Date(v.published_at).getTime() : 0);
  const fresh = open.filter((v) => t(v) >= freshCut)
    .sort((a, b) => t(b) - t(a) || (Number(b.score ?? 0) - Number(a.score ?? 0)))
    .slice(0, limit).map((v) => toCandidate(v, "fresh", v.views ?? 0));
  const archive = open.filter((v) => t(v) && t(v) <= archiveCut)
    .map((v) => ({ v, rank: (v.views ?? 0) * (v.score == null ? 0.5 : Number(v.score) / 10) }))   // unbewertet zählt halb, bis das Modell dran war
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit).map((x) => toCandidate(x.v, "archive", x.rank));
  return { fresh, archive, blocked: rows.length - open.length, unrated: open.filter((v) => v.score == null).length };
}

/** Auswahl des Agenten: 70 % Archiv, 30 % frisch – gemessen an den letzten zehn selbst gezogenen Vorschlägen. */
export async function pickForAgent(env: Env, niche: string, ws = "default"): Promise<Candidate | null> {
  const { fresh, archive } = await suggestionLists(env, niche, ws, 5);
  const recent = await db.all<{ note: string | null }>(env,
    "SELECT note FROM uploads WHERE workspace_id = ? AND note LIKE 'automatisch gewählt%' ORDER BY created_at DESC LIMIT 10", ws);
  const archiveShare = recent.length ? recent.filter((r) => (r.note ?? "").includes("Archiv")).length / recent.length : 0;
  const wantArchive = archiveShare < ARCHIVE_SHARE;                  // unter der Quote → Archiv, sonst frisch
  const first = wantArchive ? archive : fresh, second = wantArchive ? fresh : archive;
  return first[0] ?? second[0] ?? null;
}
