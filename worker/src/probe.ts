// Probelauf je Quellvideo: aus einem übernommenen Video entstehen zuerst nur die zwei bestbewerteten Momente,
// danach hält die Produktion an. Der Mensch entscheidet in der Clip-Vorschau:
//   „Rest freigeben"          → die übrigen Momente desselben Videos werden produziert
//   „Nochmal, andere Momente" → zwei neue Kandidaten, die schon gezeigten Ränge bleiben gesperrt
//   „Video verwerfen"         → Video auf rejected, es taucht in keiner Vorschlagsliste mehr auf
// Ohne Entscheidung passiert nichts: kein Zeitablauf, keine automatische Freigabe.
//
// Harte Obergrenze, damit nach einem unaufmerksamen Abend nicht sechzig Clips in der Warteschlange stehen:
// höchstens ein Video gleichzeitig im Probelauf, höchstens zwei Videos gleichzeitig in Produktion.
// Uploads, die deshalb warten, bleiben liegen und werden vom Fan-Lauf erneut versucht, sobald ein Platz frei ist.
import { Env, db, nowIso, logEvent, telegram } from "./shared";
import { dispatchClipJob } from "./scout";

export const PROBE_CLIPS = 2;             // Momente je Probelauf
export const MAX_PROBE = 1;               // nie mehr als ein Video gleichzeitig im Probelauf
export const MAX_PRODUCTION = 2;          // nie mehr als zwei Videos gleichzeitig in Produktion

const list = (v: unknown): number[] => { try { const a = JSON.parse(String(v ?? "[]")); return Array.isArray(a) ? a.map(Number).filter(Number.isFinite) : []; } catch { return []; } };

export interface Capacity {
  probe: number; production: number; max_probe: number; max_production: number;
  can_probe: boolean; can_produce: boolean; reason: string | null;
  probe_video: { id: string; title: string | null; campaign_id: string | null } | null;
  waiting: number;                        // Uploads, die auf einen freien Platz warten
}

/** Wie viele Videos gerade im Probelauf bzw. in Produktion sind – und ob noch eines dazu darf. */
export async function capacity(env: Env, ws = "default"): Promise<Capacity> {
  const probe = await db.all<any>(env, "SELECT id, title, campaign_id FROM videos WHERE workspace_id = ? AND status = 'probe'", ws);
  const prod = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM videos WHERE workspace_id = ? AND status = 'queued'", ws);
  const waiting = await db.first<{ n: number }>(env,
    "SELECT COUNT(*) AS n FROM uploads WHERE workspace_id = ? AND status IN ('uploaded','needs_download')", ws);
  const production = Number(prod?.n ?? 0);
  const canProbe = probe.length < MAX_PROBE && production + probe.length < MAX_PRODUCTION + MAX_PROBE;
  const reason = probe.length >= MAX_PROBE
    ? `Es läuft bereits ein Probelauf (${probe[0]?.title ?? probe[0]?.id}) – erst entscheiden, dann kommt das nächste Video dran.`
    : production >= MAX_PRODUCTION ? `${production} Videos sind schon in Produktion (Höchstzahl ${MAX_PRODUCTION}).` : null;
  return { probe: probe.length, production, max_probe: MAX_PROBE, max_production: MAX_PRODUCTION,
           can_probe: canProbe, can_produce: production < MAX_PRODUCTION, reason,
           probe_video: probe[0] ? { id: probe[0].id, title: probe[0].title ?? null, campaign_id: probe[0].campaign_id ?? null } : null,
           waiting: Number(waiting?.n ?? 0) };
}

/** Offener Probelauf: Kampagne, Video und die beiden Clips – für die Clip-Vorschau. */
export async function probeStatus(env: Env, ws = "default") {
  const cap = await capacity(env, ws);
  const c = await db.first<any>(env,
    "SELECT id, name, niche_id FROM campaigns WHERE workspace_id = ? AND probe_state = 'probe' ORDER BY created_at DESC LIMIT 1", ws);
  if (!c) return { open: false, ...cap };
  const v = await db.first<any>(env, "SELECT id, title, url, probe_round, blocked_ranks FROM videos WHERE workspace_id = ? AND campaign_id = ?", ws, c.id);
  const clips = await db.all<any>(env, "SELECT id, rank, status FROM clips WHERE workspace_id = ? AND campaign_id = ? AND COALESCE(probe,0) = 1 ORDER BY rank", ws, c.id);
  return { open: true, campaign_id: c.id, campaign: c.name, niche: c.niche_id, video: v ? { id: v.id, title: v.title, url: v.url } : null,
           round: Number(v?.probe_round ?? 1), blocked_ranks: list(v?.blocked_ranks), clips: clips.map((x) => ({ id: x.id, rank: x.rank, status: x.status })), ...cap };
}

/** Probelauf für eine frisch angelegte Fan-Kampagne starten (aus startUploadJob). */
export async function dispatchProbe(env: Env, campaignId: string, account: string, videoId: string | null, ws = "default"): Promise<{ ok: boolean; status: number; skipped?: string }> {
  const cap = await capacity(env, ws);
  if (!cap.can_probe) {
    await logEvent(env, `probe_wartet campaign=${campaignId} ${cap.reason ?? ""}`.slice(0, 200), campaignId);
    return { ok: false, status: 0, skipped: cap.reason ?? "Obergrenze erreicht" };
  }
  const v = videoId ? await db.first<any>(env, "SELECT blocked_ranks FROM videos WHERE id = ? AND workspace_id = ?", videoId, ws) : null;
  const skip = list(v?.blocked_ranks);
  const status = await dispatchClipJob(env, campaignId, account, {
    preview: "true", probe: String(PROBE_CLIPS), skip_ranks: skip.join(","),
  });
  if (status === 204) {
    await db.run(env, "UPDATE campaigns SET probe_state = 'probe' WHERE id = ?", campaignId);
    if (videoId) await db.run(env, "UPDATE videos SET status = 'probe', campaign_id = ?, probe_round = COALESCE(probe_round,0) + 1, dispatched_at = ?, updated_at = ? WHERE id = ?",
                              campaignId, nowIso(), nowIso(), videoId);
    await logEvent(env, `probe_gestartet campaign=${campaignId} video=${videoId ?? "-"} clips=${PROBE_CLIPS}${skip.length ? ` ohne Ränge ${skip.join(",")}` : ""}`, campaignId);
  }
  return { ok: status === 204, status };
}

export type ProbeAction = "release" | "another" | "reject";

/** Entscheidung aus der Clip-Vorschau. Nur diese drei Wege, nichts läuft von selbst weiter. */
export async function probeAction(env: Env, campaignId: string, action: ProbeAction, ws = "default") {
  const c = await db.first<any>(env, "SELECT id, name, accounts, niche_id, probe_state FROM campaigns WHERE id = ? AND workspace_id = ?", campaignId, ws);
  if (!c) return { ok: false, error: "Kampagne nicht gefunden" };
  if (c.probe_state !== "probe") return { ok: false, error: `Kampagne steht auf ${c.probe_state ?? "kein Probelauf"} – hier ist nichts zu entscheiden` };
  const v = await db.first<any>(env, "SELECT id, title, blocked_ranks, probe_round FROM videos WHERE workspace_id = ? AND campaign_id = ?", ws, campaignId);
  const clips = await db.all<any>(env, "SELECT id, rank FROM clips WHERE workspace_id = ? AND campaign_id = ? AND COALESCE(probe,0) = 1", ws, campaignId);
  const shown = clips.map((x) => Number(x.rank)).filter(Number.isFinite);
  const blocked = [...new Set([...list(v?.blocked_ranks), ...shown])].sort((a, b) => a - b);
  let account = "AB";
  try { const a = JSON.parse(c.accounts || "[]"); if (Array.isArray(a) && a.length) account = a.join(""); } catch { /* Standard */ }

  if (action === "reject") {
    await db.run(env, "UPDATE campaigns SET probe_state = 'rejected', status = 'paused' WHERE id = ?", campaignId);
    await db.run(env, "UPDATE clips SET status = 'rejected_review', note = 'Probelauf: Video verworfen' WHERE workspace_id = ? AND campaign_id = ? AND status IN ('ready','review','shadow')", ws, campaignId);
    await db.run(env, "UPDATE posts SET status = 'cancelled' WHERE workspace_id = ? AND status IN ('shadow','scheduled') AND clip_id IN (SELECT id FROM clips WHERE campaign_id = ?)", ws, campaignId);
    if (v) await db.run(env, "UPDATE videos SET status = 'rejected', note = 'Probelauf verworfen', updated_at = ? WHERE id = ?", nowIso(), v.id);
    await db.run(env, "UPDATE uploads SET status = 'cancelled', updated_at = ? WHERE workspace_id = ? AND campaign_id = ?", nowIso(), ws, campaignId);
    await logEvent(env, `probe_verworfen campaign=${campaignId} video=${v?.id ?? "-"}`, campaignId);
    await telegram(env, `🗑 Probelauf verworfen: ${v?.title ?? c.name}\nDas Video kommt nicht mehr in die Vorschlagsliste.`);
    return { ok: true, action, video: v?.id ?? null };
  }

  if (action === "another") {
    await db.run(env, "UPDATE clips SET status = 'rejected_review', note = 'Probelauf: andere Momente angefordert' WHERE workspace_id = ? AND campaign_id = ? AND COALESCE(probe,0) = 1 AND status IN ('ready','review','shadow')", ws, campaignId);
    await db.run(env, "UPDATE posts SET status = 'cancelled' WHERE workspace_id = ? AND status IN ('shadow','scheduled') AND clip_id IN (SELECT id FROM clips WHERE campaign_id = ? AND COALESCE(probe,0) = 1)", ws, campaignId);
    if (v) await db.run(env, "UPDATE videos SET blocked_ranks = ?, updated_at = ? WHERE id = ?", JSON.stringify(blocked), nowIso(), v.id);
    const status = await dispatchClipJob(env, campaignId, account, { preview: "true", probe: String(PROBE_CLIPS), skip_ranks: blocked.join(",") });
    if (status === 204 && v) await db.run(env, "UPDATE videos SET status = 'probe', probe_round = COALESCE(probe_round,0) + 1, dispatched_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), v.id);
    await logEvent(env, `probe_neue_momente campaign=${campaignId} gesperrt=${blocked.join(",")} dispatch=${status}`, campaignId);
    return { ok: status === 204, action, blocked_ranks: blocked, dispatch: status };
  }

  // release: der Rest desselben Videos wird produziert, die zwei gezeigten Momente bleiben stehen
  await db.run(env, "UPDATE campaigns SET probe_state = 'released' WHERE id = ?", campaignId);
  if (v) await db.run(env, "UPDATE videos SET blocked_ranks = ?, status = 'queued', updated_at = ? WHERE id = ?", JSON.stringify(blocked), nowIso(), v.id);
  const status = await dispatchClipJob(env, campaignId, account, { skip_ranks: blocked.join(",") });
  await logEvent(env, `probe_freigegeben campaign=${campaignId} ohne Ränge ${blocked.join(",")} dispatch=${status}`, campaignId);
  return { ok: status === 204, action, blocked_ranks: blocked, dispatch: status };
}
