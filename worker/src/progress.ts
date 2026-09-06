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
import { Env, db, nowIso, logEvent, telegram } from "./shared";
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
    if (xs.length < 3) continue;      // aus einem einzigen Lauf lässt sich kein „üblich" ableiten – dann lieber nichts sagen
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

/** Schlanker Takt fuer das Dashboard: nur was sich staendig aendert, drei Abfragen statt vierundzwanzig.
 *  Das Dashboard fragt im 30-Sekunden-Takt nur noch hier nach und laedt den vollen Datensatz erst,
 *  wenn sich wirklich etwas geruehrt hat – sonst liest ein offener Tab die Datenbank leer. */
export async function pulse(env: Env, ws = "default") {
  const rows = await db.all<JobRun>(env,
    "SELECT * FROM job_runs WHERE workspace_id = ? AND status = 'running' ORDER BY id DESC LIMIT 10", ws);
  const q = await db.first<any>(env,
    `SELECT SUM(status = 'ready') AS ready, SUM(status IN ('review')) AS review,
            SUM(status IN ('scheduled','shadow')) AS scheduled FROM clips WHERE workspace_id = ?`, ws);
  const ev = await db.first<{ id: number }>(env, "SELECT MAX(id) AS id FROM events WHERE workspace_id = ?", ws);
  const jobs = rows.map((r) => {
    const silent = age(r.heartbeat_at);
    return { key: r.campaign_id ?? r.upload_id ?? String(r.id), stage: r.stage, stage_label: STAGE_LABEL[r.stage] ?? r.stage,
             status: silent > STUCK_MIN * 60 ? "stuck" : "running", percent: r.progress == null ? null : Math.round(clamp01(Number(r.progress)) * 100),
             detail: r.detail, since_s: age(r.started_at), silent_s: silent };
  });
  // Ein einziger Wert, an dem das Dashboard erkennt, ob sich etwas geaendert hat.
  const stand = [ev?.id ?? 0, q?.ready ?? 0, q?.review ?? 0, q?.scheduled ?? 0,
                 jobs.map((j) => `${j.key}:${j.stage}:${j.status}:${j.percent ?? ""}`).join(",")].join("|");
  return { at: nowIso(), stand, jobs, queue: { ready: Number(q?.ready ?? 0), review: Number(q?.review ?? 0), scheduled: Number(q?.scheduled ?? 0) } };
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
  // Zwei Wege: nach zwei Stunden ohne Zeichen in jedem Fall – und schon nach zehn Minuten, wenn GitHub sagt,
  // der zugehörige Actions-Lauf sei zu Ende. Dann muss niemand zwei Stunden auf die Wahrheit warten.
  const still = new Date(Date.now() - STUCK_MIN * 60e3).toISOString();
  const kandidaten = await db.all<JobRun>(env,
    "SELECT * FROM job_runs WHERE workspace_id = ? AND status = 'running' AND heartbeat_at < ? AND run_id IS NOT NULL ORDER BY id DESC LIMIT 5",
    ws, still);
  const dead = await db.all<JobRun>(env,
    "SELECT * FROM job_runs WHERE workspace_id = ? AND status = 'running' AND heartbeat_at < ? ORDER BY id DESC LIMIT 50", ws, cutoff);
  for (const j of kandidaten) {
    if (dead.some((d) => d.id === j.id)) continue;
    const state = await actionsRunState(env, j.run_id!).catch(() => null);
    if (state && state.status === "completed") dead.push(j);
  }
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
  const frei = await recoverProbes(env, ws);
  return { cleaned: dead.length - finished, finished, recovered: frei.length, recovered_probes: frei,
           stages: dead.map((j) => `${j.campaign_id ?? j.upload_id}:${j.stage}`) };
}

export const MAX_REVIVE = 3;      // so oft wird ein gescheiterter Clip-Job automatisch neu angestoßen

/** Gescheiterte Clip-Jobs, die nichts hinterlassen haben, werden von selbst neu angestoßen – ein Absturz darf
 *  nicht in „gar keine Clips" enden. Zwei Fälle:
 *    • Probelauf: Kampagne steht auf 'probe', es gibt aber keinen Clip zu entscheiden (blockiert sonst den Platz)
 *    • Jede andere aktive Kampagne, deren letzter Lauf gescheitert ist und die keinen einzigen Clip hat
 *  Höchstens drei Runden je Kampagne, immer nur ein Job gleichzeitig. Danach bleibt es liegen und Telegram fragt nach. */
export async function recoverProbes(env: Env, ws = "default"): Promise<string[]> {
  const busy = await db.first<{ n: number }>(env,
    "SELECT COUNT(*) AS n FROM job_runs WHERE workspace_id = ? AND status = 'running'", ws);
  if ((busy?.n ?? 0) > 0) return [];                            // immer nur ein Clip-Job gleichzeitig (YouTube-Cookies)
  const offen = await db.all<any>(env,
    "SELECT id, name, accounts FROM campaigns WHERE workspace_id = ? AND probe_state = 'probe' LIMIT 3", ws);
  const wieder: string[] = [];
  for (const c of offen) {
    const clips = await db.first<{ n: number }>(env,
      "SELECT COUNT(*) AS n FROM clips WHERE workspace_id = ? AND campaign_id = ? AND COALESCE(probe,0) = 1 AND status NOT IN ('rejected_review','superseded')", ws, c.id);
    if ((clips?.n ?? 0) > 0) continue;                         // es liegt etwas zum Entscheiden vor – nichts zu tun
    const läuft = await db.first<{ n: number }>(env,
      "SELECT COUNT(*) AS n FROM job_runs WHERE workspace_id = ? AND campaign_id = ? AND status = 'running'", ws, c.id);
    if ((läuft?.n ?? 0) > 0) continue;                          // der Lauf arbeitet noch
    const v = await db.first<any>(env, "SELECT id, title, probe_round FROM videos WHERE workspace_id = ? AND campaign_id = ?", ws, c.id);
    const runde = Number(v?.probe_round ?? 0);
    if (runde >= 3) {                                           // dreimal gescheitert: nicht endlos weiterversuchen
      await db.run(env, "UPDATE campaigns SET probe_state = 'rejected', status = 'paused' WHERE id = ?", c.id);
      if (v) await db.run(env, "UPDATE videos SET status = 'error', note = 'Probelauf dreimal gescheitert', updated_at = ? WHERE id = ?", nowIso(), v.id);
      await logEvent(env, `probe_aufgegeben campaign=${c.id} video=${v?.id ?? "-"} nach ${runde} Runden – Platz wieder frei`, c.id);
      await telegram(env, `⚠️ Probelauf ${v?.title ?? c.name} dreimal gescheitert – Video aussortiert, der Platz ist wieder frei.`);
      wieder.push(`${c.id}:aufgegeben`);
      continue;
    }
    let account = "AB";
    try { const a = JSON.parse(c.accounts || "[]"); if (Array.isArray(a) && a.length) account = a.join(""); } catch { /* Standard */ }
    const status = await dispatchClipJob(env, c.id, account, { preview: "true", probe: String(PROBE_CLIPS) });
    if (status === 204 && v) await db.run(env, "UPDATE videos SET probe_round = COALESCE(probe_round,0) + 1, dispatched_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), v.id);
    await logEvent(env, `probe_neustart campaign=${c.id} video=${v?.id ?? "-"} runde=${runde + 1} dispatch=${status} (vorheriger Lauf ohne Clips beendet)`, c.id);
    wieder.push(`${c.id}:neu gestartet`);
    return wieder;                                              // ein Job je Durchgang reicht
  }
  return [...wieder, ...(await reviveFailed(env, ws))];
}

/** Kampagne ohne Probelauf, deren letzter Lauf gescheitert ist und die keinen Clip hat → einmal neu anstoßen. */
async function reviveFailed(env: Env, ws: string): Promise<string[]> {
  const kandidaten = await db.all<any>(env,
    `SELECT j.campaign_id AS id, MAX(j.ended_at) AS zuletzt,
            SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS versuche
       FROM job_runs j WHERE j.workspace_id = ? AND j.campaign_id IS NOT NULL AND j.ended_at >= ?
      GROUP BY j.campaign_id HAVING versuche > 0 ORDER BY zuletzt DESC LIMIT 5`,
    ws, new Date(Date.now() - 12 * 3600e3).toISOString());
  for (const k of kandidaten) {
    if (Number(k.versuche) >= MAX_REVIVE) continue;
    const c = await db.first<any>(env,
      "SELECT id, name, accounts, kind, status, probe_state FROM campaigns WHERE id = ? AND workspace_id = ?", k.id, ws);
    if (!c || c.probe_state === "probe" || c.probe_state === "rejected" || c.status === "paused") continue;
    const clips = await db.first<{ n: number }>(env,
      "SELECT COUNT(*) AS n FROM clips WHERE workspace_id = ? AND campaign_id = ? AND status NOT IN ('superseded','test_private')", ws, k.id);
    if ((clips?.n ?? 0) > 0) continue;                          // es sind Clips entstanden – kein Grund für einen Neustart
    const letzter = await db.first<{ run_id: string | null }>(env,
      "SELECT run_id FROM job_runs WHERE workspace_id = ? AND campaign_id = ? AND run_id IS NOT NULL ORDER BY id DESC LIMIT 1", ws, k.id);
    if (letzter?.run_id) {                                      // arbeitet der Actions-Lauf noch (z.B. Rückfall auf den alten
      const st = await actionsRunState(env, letzter.run_id).catch(() => null);   // Weg), wäre ein Neustart ein zweiter Job
      if (st && st.status !== "completed") continue;
    }
    let account = "AB";
    try { const a = JSON.parse(c.accounts || "[]"); if (Array.isArray(a) && a.length) account = a.join(""); } catch { /* Standard */ }
    const status = await dispatchClipJob(env, c.id, account, {});
    await logEvent(env, `job_neustart campaign=${c.id} versuch=${Number(k.versuche) + 1}/${MAX_REVIVE} dispatch=${status} (letzter Lauf gescheitert, keine Clips)`, c.id);
    if (Number(k.versuche) + 1 >= MAX_REVIVE)
      await telegram(env, `⚠️ ${c.name}: dritter Anlauf für den Clip-Job. Kommt auch der nicht durch, schaue ich mir das Actions-Protokoll an.`);
    return [`${c.id}:neu gestartet`];                            // immer nur einer je Durchgang
  }
  return [];
}
