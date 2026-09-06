// Fortschritt, Lebenszeichen, Abbrechen und Wiederholen je Stufe eines Clip-Jobs.
//
// Der eigentliche Zweck: nicht raten müssen, ob ein Lauf arbeitet oder tot ist.
//   • Wo echter Fortschritt messbar ist, steht Prozent: Upload (übertragene Bytes), Transkript (verarbeitete Länge),
//     Schnitt/Render (ffmpeg -progress gegen die Zielspieldauer).
//   • Wo nichts messbar ist (Momentwahl, QA), steht „läuft seit 3 min (üblich 2–4 min)" – der Erwartungswert kommt
//     aus den letzten zwanzig abgeschlossenen Läufen derselben Stufe, nicht aus einer geschätzten Konstante.
//   • Jeder laufende Job schreibt alle 30 Sekunden einen Zeitstempel. Kommt zehn Minuten nichts, heißt die Stufe
//     „hängt" – mit dem letzten bekannten Stand und dem Link auf den Actions-Lauf.
//   • Zwei Stunden ohne Lebenszeichen räumt der nächste Cron-Lauf auf 'failed' ab, sonst sammeln sich Karteileichen.
import { Env, db, nowIso, logEvent } from "./shared";
import { dispatchClipJob } from "./scout";
import { PROBE_CLIPS } from "./probe";

export const BEAT_S = 30;            // Takt der Lebenszeichen aus der Pipeline
export const STUCK_MIN = 10;         // so lange ohne Zeichen → „hängt"
export const CLEAN_H = 2;            // so lange ohne Zeichen → der Cron setzt auf failed

export const STAGES = ["download", "transcript", "moments", "cut", "render", "qa"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<string, string> = {
  download: "Upload", transcript: "Transkript", moments: "Momentwahl", cut: "Schnitt", render: "Render", qa: "QA",
};
/** Stufen mit echtem Messwert – überall sonst gibt es statt Prozent den Erwartungswert. */
export const MEASURABLE = new Set<string>(["download", "transcript", "cut", "render"]);

export interface JobRun {
  id: number; campaign_id: string | null; upload_id: string | null; run_id: string | null; account: string | null;
  stage: string; status: string; progress: number | null; detail: string | null;
  started_at: string; heartbeat_at: string; ended_at: string | null; note: string | null;
}

const age = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** „3 min" / „48 s" – kurze deutsche Dauer. */
export function humanDur(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} s`;
  const m = sec / 60;
  return m < 60 ? `${Math.round(m)} min` : `${Math.round(m / 6) / 10} h`;
}

/** Spanne in einer Einheit: „2–4 min", bei gleichem Wert „rund 3 min". */
export function humanSpan(lo: number, hi: number): string {
  const a = humanDur(lo), b = humanDur(hi);
  if (a === b) return `rund ${a}`;
  const ea = a.split(" ")[1], eb = b.split(" ")[1];
  return ea === eb ? `${a.split(" ")[0]}–${b}` : `${a}–${b}`;
}

// ---------- Schreiben (Pipeline und Upload melden hierher) ----------

export interface ProgressReport {
  campaign_id?: string | null; upload_id?: string | null; stage: string;
  status?: "running" | "done" | "failed" | "cancelled";
  progress?: number | null; detail?: string | null; run_id?: string | null; account?: string | null; note?: string | null;
}

/** Meldung einer Stufe: legt die Zeile an oder frischt sie auf (heartbeat_at ist immer jetzt).
 *  Eine Meldung ist zugleich das Lebenszeichen – die Pipeline schickt sie alle 30 Sekunden, auch ohne neuen Stand. */
export async function reportProgress(env: Env, b: ProgressReport, ws = "default") {
  const stage = String(b.stage ?? "").trim();
  if (!stage) return { ok: false, error: "stage fehlt" };
  const cid = b.campaign_id ? String(b.campaign_id) : null;
  const uid = b.upload_id ? String(b.upload_id) : null;
  if (!cid && !uid) return { ok: false, error: "campaign_id oder upload_id nötig" };
  const status = b.status ?? "running";
  const done = status !== "running";
  const now = nowIso();
  const cur = await db.first<JobRun>(env,
    `SELECT * FROM job_runs WHERE workspace_id = ? AND stage = ? AND status = 'running'
       AND ((campaign_id IS NOT NULL AND campaign_id = ?) OR (upload_id IS NOT NULL AND upload_id = ?))
     ORDER BY id DESC LIMIT 1`, ws, stage, cid, uid);
  if (cur) {
    await db.run(env,
      `UPDATE job_runs SET status = ?, progress = COALESCE(?, progress), detail = COALESCE(?, detail),
              run_id = COALESCE(?, run_id), account = COALESCE(?, account), campaign_id = COALESCE(?, campaign_id),
              note = COALESCE(?, note), heartbeat_at = ?, ended_at = ? WHERE id = ?`,
      status, b.progress ?? null, b.detail ?? null, b.run_id ?? null, b.account ?? null, cid,
      b.note ?? null, now, done ? now : null, cur.id);
    return { ok: true, id: cur.id, stage, status };
  }
  const r = await db.run(env,
    `INSERT INTO job_runs (workspace_id, campaign_id, upload_id, run_id, account, stage, status, progress, detail, started_at, heartbeat_at, ended_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ws, cid, uid, b.run_id ?? null, b.account ?? null, stage, status, b.progress ?? null, b.detail ?? null,
    now, now, done ? now : null, b.note ?? null);
  // frühere Stufen desselben Jobs gelten mit der neuen Stufe als abgeschlossen (die Pipeline meldet nicht immer 'done')
  if (!done) await db.run(env,
    `UPDATE job_runs SET status = 'done', ended_at = ? WHERE workspace_id = ? AND status = 'running' AND stage != ?
       AND ((campaign_id IS NOT NULL AND campaign_id = ?) OR (upload_id IS NOT NULL AND upload_id = ?))`,
    now, ws, stage, cid, uid);
  return { ok: true, id: Number((r as any)?.meta?.last_row_id ?? 0), stage, status };
}

// ---------- Erwartungswert je Stufe (Mittel der letzten zwanzig Läufe) ----------

export interface Expect { stage: string; n: number; mean_s: number; lo_s: number; hi_s: number; text: string }

export async function expectations(env: Env, ws = "default"): Promise<Record<string, Expect>> {
  const rows = await db.all<{ stage: string; secs: number }>(env,
    `SELECT stage, (julianday(ended_at) - julianday(started_at)) * 86400 AS secs
       FROM job_runs WHERE workspace_id = ? AND status = 'done' AND ended_at IS NOT NULL
     ORDER BY id DESC LIMIT 400`, ws);
  const out: Record<string, Expect> = {};
  for (const st of new Set(rows.map((r) => r.stage))) {
    const xs = rows.filter((r) => r.stage === st).slice(0, 20).map((r) => Number(r.secs)).filter((n) => n > 0 && n < 6 * 3600);
    if (!xs.length) continue;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sorted = [...xs].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
    const lo = xs.length >= 4 ? q(0.2) : mean * 0.7;
    const hi = xs.length >= 4 ? q(0.8) : mean * 1.4;
    out[st] = { stage: st, n: xs.length, mean_s: Math.round(mean), lo_s: Math.round(lo), hi_s: Math.round(hi),
                text: `üblich ${humanSpan(lo, hi)}` };
  }
  return out;
}

// ---------- Lesen (Dashboard) ----------

export interface JobView {
  key: string; campaign_id: string | null; upload_id: string | null; account: string | null;
  stage: string; stage_label: string; status: "running" | "stuck" | "done" | "failed" | "cancelled";
  percent: number | null; detail: string | null; text: string;
  since_s: number; silent_s: number; started_at: string; heartbeat_at: string;
  run_id: string | null; run_url: string | null; expect: Expect | null; note: string | null;
  can_cancel: boolean; can_retry: boolean;
}

const view = (j: JobRun, exp: Record<string, Expect>, repo?: string): JobView => {
  const silent = age(j.heartbeat_at), since = age(j.started_at);
  const stuck = j.status === "running" && silent > STUCK_MIN * 60;
  const status = (stuck ? "stuck" : j.status) as JobView["status"];
  const e = exp[j.stage] ?? null;
  const pct = j.progress == null ? null : Math.round(clamp01(Number(j.progress)) * 100);
  let text: string;
  if (status === "stuck")
    text = `hängt – seit ${humanDur(silent)} kein Lebenszeichen${j.detail ? `, zuletzt: ${j.detail}` : pct != null ? `, zuletzt ${pct} %` : ""}`;
  else if (status === "running" && pct != null) text = `${pct} %${j.detail ? ` · ${j.detail}` : ""}`;
  else if (status === "running") text = `läuft seit ${humanDur(since)}${e ? ` (${e.text})` : ""}`;
  else if (status === "done") text = `fertig in ${humanDur(since)}`;
  else if (status === "cancelled") text = `abgebrochen${j.note ? ` · ${j.note}` : ""}`;
  else text = `fehlgeschlagen${j.note ? ` · ${j.note}` : ""}`;
  return {
    key: j.campaign_id ?? j.upload_id ?? String(j.id), campaign_id: j.campaign_id, upload_id: j.upload_id, account: j.account,
    stage: j.stage, stage_label: STAGE_LABEL[j.stage] ?? j.stage, status, percent: pct, detail: j.detail, text,
    since_s: since, silent_s: silent, started_at: j.started_at, heartbeat_at: j.heartbeat_at,
    run_id: j.run_id, run_url: j.run_id && repo ? `https://github.com/${repo}/actions/runs/${j.run_id}` : null,
    expect: e, note: j.note,
    can_cancel: j.status === "running", can_retry: j.status !== "running" || stuck,
  };
};

/** Laufende und zuletzt beendete Stufen – je Quelle die jüngste Zeile. */
export async function jobProgress(env: Env, ws = "default", key?: string): Promise<{ jobs: JobView[]; expect: Record<string, Expect>; stuck: number; running: number; beat_s: number; stuck_min: number }> {
  const exp = await expectations(env, ws);
  const rows = key
    ? await db.all<JobRun>(env, `SELECT * FROM job_runs WHERE workspace_id = ? AND (campaign_id = ? OR upload_id = ?) ORDER BY id DESC LIMIT 40`, ws, key, key)
    : await db.all<JobRun>(env, `SELECT * FROM job_runs WHERE workspace_id = ? AND (status = 'running' OR heartbeat_at >= ?) ORDER BY id DESC LIMIT 120`,
                           ws, new Date(Date.now() - 24 * 3600e3).toISOString());
  const seen = new Set<string>();
  const jobs: JobView[] = [];
  for (const r of rows) {
    const k = `${r.campaign_id ?? ""}|${r.upload_id ?? ""}${key ? `|${r.stage}` : ""}`;
    if (seen.has(k)) continue;                       // je Quelle zählt die jüngste Stufe (bei ?key= alle Stufen einmal)
    seen.add(k);
    jobs.push(view(r, exp, env.GITHUB_REPO));
  }
  // Zweite Quelle für „hängt": bleibt das Lebenszeichen aus, aber GitHub sagt, der Lauf arbeitet noch, ist er nicht tot.
  // (Höchstens drei Abfragen je Aufruf – „hängt" ist der Ausnahmefall, nicht der Normalfall.)
  let gefragt = 0;
  for (const j of jobs) {
    if (j.status !== "stuck" || !j.run_id || gefragt >= 3) continue;
    gefragt++;
    const state = await actionsRunState(env, j.run_id).catch(() => null);
    if (!state) continue;
    if (state.status === "queued" || state.status === "in_progress") {
      j.status = "running";
      j.text = `läuft (Actions-Lauf aktiv), meldet sich aber seit ${humanDur(j.silent_s)} nicht`;
    } else {
      j.text = `hängt – Actions-Lauf ${state.status}${state.conclusion ? `/${state.conclusion}` : ""}, letztes Lebenszeichen vor ${humanDur(j.silent_s)}`;
    }
  }
  return { jobs, expect: exp, stuck: jobs.filter((j) => j.status === "stuck").length,
           running: jobs.filter((j) => j.status === "running").length, beat_s: BEAT_S, stuck_min: STUCK_MIN };
}

// ---------- GitHub Actions: Lauf abbrechen ----------

/** POST /repos/:repo/actions/runs/:id/cancel – 202 abgebrochen, 409 lief nicht mehr, 403 fehlendes Recht (actions: write). */
export async function cancelActionsRun(env: Env, runId: string): Promise<{ ok: boolean; status: number; message: string }> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return { ok: false, status: 0, message: "GITHUB_TOKEN/REPO fehlt" };
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${runId}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "clipforge-worker" },
  });
  const body = r.status === 202 ? "" : (await r.text()).slice(0, 200);
  const message = r.status === 202 ? "Lauf abgebrochen"
    : r.status === 409 ? "Der Actions-Lauf war schon zu Ende"
    : r.status === 403 ? "Der Worker-Token darf keine Läufe abbrechen (Recht „Actions: write“ fehlt)"
    : r.status === 404 ? "Actions-Lauf nicht gefunden"
    : `GitHub antwortet ${r.status}: ${body}`;
  return { ok: r.status === 202, status: r.status, message };
}

/** Zustand eines Laufs (queued|in_progress|completed) – für die Anzeige, wenn kein Lebenszeichen mehr kommt. */
export async function actionsRunState(env: Env, runId: string): Promise<{ status: string; conclusion: string | null } | null> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return null;
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${runId}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "clipforge-worker" },
  });
  if (!r.ok) return null;
  const j = (await r.json()) as any;
  return { status: String(j.status ?? ""), conclusion: j.conclusion ?? null };
}

// ---------- Abbrechen und Stufe wiederholen ----------

const jobsOf = (env: Env, ws: string, key: string) => db.all<JobRun>(env,
  `SELECT * FROM job_runs WHERE workspace_id = ? AND (campaign_id = ? OR upload_id = ?) ORDER BY id DESC LIMIT 20`, ws, key, key);

/** Laufenden Actions-Lauf beenden, Stufe auf cancelled setzen, Grund ins Ereignis-Log. `key` ist Kampagne oder Upload. */
export async function cancelJob(env: Env, key: string, reason: string, ws = "default") {
  const rows = await jobsOf(env, ws, key);
  const running = rows.filter((r) => r.status === "running");
  if (!running.length) return { ok: false, error: "Für diese Quelle läuft gerade keine Stufe." };
  const runId = running.find((r) => r.run_id)?.run_id ?? rows.find((r) => r.run_id)?.run_id ?? null;
  const cid = running[0].campaign_id ?? null;
  const grund = (reason || "").trim().slice(0, 160) || "im Dashboard abgebrochen";
  let run = { ok: false, status: 0, message: "kein Actions-Lauf hinterlegt" };
  if (runId) run = await cancelActionsRun(env, runId);
  const now = nowIso();
  for (const r of running)
    await db.run(env, "UPDATE job_runs SET status = 'cancelled', ended_at = ?, note = ? WHERE id = ?", now, grund, r.id);
  if (cid) await db.run(env, "UPDATE campaigns SET status = 'paused' WHERE id = ? AND workspace_id = ?", cid, ws);
  await db.run(env, "UPDATE uploads SET status = 'cancelled', note = ?, updated_at = ? WHERE workspace_id = ? AND (id = ? OR campaign_id = ?)",
               `abgebrochen: ${grund}`, now, ws, key, key);
  await db.run(env, "UPDATE videos SET status = 'cancelled', note = ?, updated_at = ? WHERE workspace_id = ? AND campaign_id = ? AND status IN ('probe','queued')",
               `abgebrochen: ${grund}`, now, ws, cid);
  await logEvent(env, `job_abgebrochen quelle=${key} stufe=${running.map((r) => r.stage).join(",")} run=${runId ?? "-"} grund=${grund} github=${run.status}`, cid);
  return { ok: true, cancelled: running.map((r) => r.stage), run_id: runId, actions: run };
}

/** Dieselbe Stufe neu starten, ohne von vorn zu beginnen: fertige Ränge bleiben gesperrt, `resume` überspringt
 *  die Stufen davor (Transkript kommt aus dem R2-Zwischenspeicher, siehe pipeline/transcribe.py). */
export async function retryStage(env: Env, key: string, stage: string | null, ws = "default") {
  const rows = await jobsOf(env, ws, key);
  const last = rows[0];
  if (!last) return { ok: false, error: "Zu dieser Quelle gibt es keinen Lauf." };
  const st = (stage || last.stage || "download").trim();
  if (!STAGES.includes(st as Stage)) return { ok: false, error: `Unbekannte Stufe ${st}` };
  const cid = last.campaign_id ?? (await db.first<any>(env, "SELECT campaign_id FROM uploads WHERE id = ? AND workspace_id = ?", key, ws))?.campaign_id ?? null;
  if (!cid) return { ok: false, error: "Zu dieser Quelle gibt es keine Kampagne – erst hochladen." };
  const running = rows.filter((r) => r.status === "running");
  if (running.length) {                                   // erst den alten Lauf beenden, sonst schneiden zwei gleichzeitig
    const runId = running.find((r) => r.run_id)?.run_id;
    if (runId) await cancelActionsRun(env, runId);
    for (const r of running) await db.run(env, "UPDATE job_runs SET status = 'cancelled', ended_at = ?, note = 'ersetzt durch Wiederholung' WHERE id = ?", nowIso(), r.id);
  }
  const c = await db.first<any>(env, "SELECT accounts, probe_state FROM campaigns WHERE id = ? AND workspace_id = ?", cid, ws);
  if (!c) return { ok: false, error: `Kampagne ${cid} gibt es nicht mehr – hier ist nichts zu wiederholen.` };
  let account = last.account ?? "AB";
  try { const a = JSON.parse(c?.accounts || "[]"); if (Array.isArray(a) && a.length) account = a.join(""); } catch { /* Standard */ }
  const done = await db.all<{ rank: number }>(env, "SELECT rank FROM clips WHERE workspace_id = ? AND campaign_id = ? AND rank IS NOT NULL AND status NOT IN ('rejected_review','superseded')", ws, cid);
  const skip = [...new Set(done.map((r) => Number(r.rank)).filter(Number.isFinite))].sort((a, b) => a - b);
  // Ein Probelauf bleibt beim Wiederholen ein Probelauf – sonst würde die Obergrenze von zwei Clips unbemerkt fallen.
  const probe: Record<string, string> = c?.probe_state === "probe" ? { preview: "true", probe: String(PROBE_CLIPS) } : {};
  const status = await dispatchClipJob(env, cid, account, { resume: st, skip_ranks: skip.join(","), ...probe });
  if (status === 204) {
    await reportProgress(env, { campaign_id: cid, upload_id: last.upload_id, stage: st, account, detail: "Wiederholung gestartet" }, ws);
    await db.run(env, "UPDATE campaigns SET status = 'active' WHERE id = ? AND workspace_id = ? AND status = 'paused'", cid, ws);
  }
  await logEvent(env, `stufe_wiederholt quelle=${key} stufe=${st}${skip.length ? ` ohne Ränge ${skip.join(",")}` : ""} dispatch=${status}`, cid);
  return { ok: status === 204, stage: st, campaign_id: cid, account, skip_ranks: skip, dispatch: status,
           error: status === 204 ? undefined : `GitHub-Dispatch antwortet ${status}` };
}

// ---------- Aufräumen (jeder Cron-Lauf) ----------

/** Läuft seit über zwei Stunden ohne Lebenszeichen → failed mit Vermerk. Sonst sammeln sich Karteileichen. */
export async function cleanupJobs(env: Env, ws = "default") {
  const cutoff = new Date(Date.now() - CLEAN_H * 3600e3).toISOString();
  const dead = await db.all<JobRun>(env,
    "SELECT * FROM job_runs WHERE workspace_id = ? AND status = 'running' AND heartbeat_at < ? ORDER BY id DESC LIMIT 50", ws, cutoff);
  let finished = 0;
  for (const j of dead) {
    const state = j.run_id ? await actionsRunState(env, j.run_id).catch(() => null) : null;
    // Erst prüfen, ob der Lauf in Wahrheit fertig geworden ist (die Meldung kann ausgefallen sein) – sonst
    // stünde ein geglückter Lauf hinterher als Fehler da und die Quelle würde fälschlich auf 'error' gesetzt.
    const ok = j.campaign_id
      ? await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND campaign_id = ? AND at >= ? AND event LIKE 'pipeline_done%'", ws, j.campaign_id, j.started_at)
      : null;
    if ((ok?.n ?? 0) > 0 || state?.conclusion === "success") {
      await db.run(env, "UPDATE job_runs SET status = 'done', ended_at = ?, note = ? WHERE id = ?",
                   nowIso(), "nachgetragen: der Lauf war fertig, nur die Meldung fehlte", j.id);
      finished++;
      continue;
    }
    const note = `ohne Lebenszeichen seit ${humanDur(age(j.heartbeat_at))} – automatisch beendet${state ? ` (Actions-Lauf ${state.status}${state.conclusion ? `/${state.conclusion}` : ""})` : ""}`;
    await db.run(env, "UPDATE job_runs SET status = 'failed', ended_at = ?, note = ? WHERE id = ?", nowIso(), note.slice(0, 200), j.id);
    await db.run(env, "UPDATE uploads SET status = 'error', note = ?, updated_at = ? WHERE workspace_id = ? AND status IN ('uploading','clipped') AND (id = ? OR campaign_id = ?)",
                 note.slice(0, 200), nowIso(), ws, j.upload_id ?? "", j.campaign_id ?? "");
    await logEvent(env, `job_leiche stufe=${j.stage} quelle=${j.campaign_id ?? j.upload_id} run=${j.run_id ?? "-"} ${note}`.slice(0, 300), j.campaign_id);
  }
  return { cleaned: dead.length - finished, finished, stages: dead.map((j) => `${j.campaign_id ?? j.upload_id}:${j.stage}`) };
}
