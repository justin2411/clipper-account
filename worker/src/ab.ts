// A/B-Test (Stufe 4): eine aktive Variable je Workspace (kv ab:<ws>), z.B. visual.anim = pop | slide. Die Pipeline liest den Test über
// GET /api/settings/effective (Feld ab) und rendert Clips abwechselnd mit den Varianten (clips.variant = "<variable>=<wert>").
// Auswertung: Clips/Posts/Views/Likes/Engagement je Variante aus D1; Watchtime/Completion liefert Blotato nicht (bleibt null, wird als „–" gezeigt).
// Signifikanz-Hinweis: mindestens 20 gepostete Clips je Variante und ≥ 20 % Unterschied im Ø-Views. „Gewinner übernehmen" schreibt den Wert
// über putSettings in die Nische (Diff + Version wie beim Speichern) und beendet den Test.
import { Env, db, nowIso, logEvent } from "./shared";
import { getSettings, putSettings, diffSettings, validateSettings } from "./settings";

export interface Experiment { variable: string; variants: string[]; niche: string; started_at: string; note?: string }
export interface VariantStats { value: string; clips: number; posts: number; views: number; avg_views: number; likes: number; engagement: number | null; watchtime: number | null; completion: number | null }
export interface AbStatus { experiment: Experiment | null; variants: VariantStats[]; min_n: number; significant: boolean; leader: string | null; lift_pct: number | null; hint: string }

export const AB_VARIABLES: Record<string, { label: string; values?: string[]; kind: "enum" | "number" | "text" }> = {
  "visual.anim": { label: "Einblendung", values: ["none", "pop", "slide", "typewriter"], kind: "enum" },
  "visual.accent_mode": { label: "Akzentwort", values: ["none", "last2", "first", "keyword"], kind: "enum" },
  "visual.font": { label: "Schrift", values: ["Anton", "Bangers", "Bebas Neue", "Luckiest Guy", "Montserrat", "Oswald", "Archivo Black"], kind: "enum" },
  "visual.box": { label: "Box", values: ["none", "solid", "blur"], kind: "enum" },
  "visual.hook_case": { label: "Großschreibung", values: ["upper", "none"], kind: "enum" },
  "visual.hook_size": { label: "Schriftgröße", kind: "number" },
  "visual.hook_y_pct": { label: "Hook-Position", kind: "number" },
  "caption.tone": { label: "Caption-Ton", values: ["knapp", "locker"], kind: "enum" },
  "cut.end_style": { label: "Clip-Ende", values: ["freeze", "cut", "none"], kind: "enum" },
  "cut.max_s": { label: "Max. Länge (s)", kind: "number" },
};
const MIN_N = 20;

export async function getExperiment(env: Env, ws = "default"): Promise<Experiment | null> {
  const r = await db.first<{ value: string }>(env, "SELECT value FROM kv WHERE key = ?", `ab:${ws}`);
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return null; }
}

export async function startExperiment(env: Env, body: { variable?: string; variants?: unknown[]; niche?: string; note?: string }, ws = "default"): Promise<{ ok: boolean; error?: string; experiment?: Experiment }> {
  const variable = String(body.variable ?? "");
  const def = AB_VARIABLES[variable];
  if (!def) return { ok: false, error: `Variable unbekannt: ${variable} (${Object.keys(AB_VARIABLES).join(", ")})` };
  const variants = (body.variants ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (variants.length < 2 || variants.length > 3) return { ok: false, error: "2–3 Varianten angeben" };
  if (new Set(variants).size !== variants.length) return { ok: false, error: "Varianten müssen sich unterscheiden" };
  if (def.values && variants.some((v) => !def.values!.includes(v))) return { ok: false, error: `Erlaubt: ${def.values.join(" | ")}` };
  if (def.kind === "number" && variants.some((v) => !Number.isFinite(Number(v)))) return { ok: false, error: "Zahlen erwartet" };
  const s = await getSettings(env, ws);
  const niche = String(body.niche ?? Object.keys(s.niches)[0] ?? "mrbeast");
  if (!s.niches[niche]) return { ok: false, error: `Nische unbekannt: ${niche}` };
  const ex: Experiment = { variable, variants, niche, started_at: nowIso(), note: body.note ? String(body.note).slice(0, 200) : undefined };
  await db.run(env, "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", `ab:${ws}`, JSON.stringify(ex), nowIso());
  await logEvent(env, `ab_started ${variable}=${variants.join("|")} niche=${niche}`);
  return { ok: true, experiment: ex };
}

export async function stopExperiment(env: Env, ws = "default", reason = "beendet") {
  const ex = await getExperiment(env, ws);
  await db.run(env, "DELETE FROM kv WHERE key = ?", `ab:${ws}`);
  if (ex) await logEvent(env, `ab_stopped ${ex.variable} ${reason}`);
  return { ok: true, was: ex };
}

/** Auswertung je Variante: Clips seit Teststart mit variant = "<variable>=<wert>", Posts mit Views/Likes. */
export async function abStats(env: Env, ws = "default"): Promise<AbStatus> {
  const ex = await getExperiment(env, ws);
  if (!ex) return { experiment: null, variants: [], min_n: MIN_N, significant: false, leader: null, lift_pct: null, hint: "Kein A/B-Test aktiv." };
  const variants: VariantStats[] = [];
  for (const value of ex.variants) {
    const tag = `${ex.variable}=${value}`;
    const c = await db.first<any>(env, "SELECT COUNT(*) AS n FROM clips WHERE workspace_id = ? AND variant = ? AND created_at >= ? AND status NOT LIKE 'rejected%'", ws, tag, ex.started_at);
    const p = await db.first<any>(env,
      `SELECT COUNT(*) AS posts, COALESCE(SUM(COALESCE(p.views, p.views_7d, p.views_72h, p.views_24h)),0) AS views, COALESCE(SUM(p.likes),0) AS likes,
              SUM(CASE WHEN COALESCE(p.views, p.views_7d, p.views_72h, p.views_24h) IS NOT NULL THEN 1 ELSE 0 END) AS with_views
       FROM posts p JOIN clips c ON c.id = p.clip_id WHERE c.workspace_id = ? AND c.variant = ? AND p.status IN ('posted','submitted') AND p.mode != 'shadow'`, ws, tag);
    const posts = Number(p?.posts ?? 0), views = Number(p?.views ?? 0), likes = Number(p?.likes ?? 0), withViews = Number(p?.with_views ?? 0);
    variants.push({ value, clips: Number(c?.n ?? 0), posts, views, avg_views: withViews ? Math.round(views / withViews) : 0, likes,
                    engagement: views ? Math.round((likes / views) * 1000) / 10 : null, watchtime: null, completion: null });
  }
  const ranked = [...variants].filter((v) => v.posts > 0).sort((a, b) => b.avg_views - a.avg_views);
  const leader = ranked[0] ?? null, second = ranked[1] ?? null;
  const lift = leader && second && second.avg_views ? Math.round(((leader.avg_views - second.avg_views) / second.avg_views) * 100) : null;
  const enough = variants.every((v) => v.posts >= MIN_N);
  const significant = !!(enough && leader && lift != null && Math.abs(lift) >= 20);
  const minPosts = Math.min(...variants.map((v) => v.posts));
  const hint = !leader ? "Noch keine geposteten Clips je Variante."
    : !enough ? `Noch nicht aussagekräftig: mindestens ${MIN_N} gepostete Clips je Variante nötig (aktuell ${minPosts}). Tendenz: ${leader.value}${lift != null ? ` (+${lift} %)` : ""}.`
    : significant ? `Aussagekräftig: ${leader.value} liegt ${lift} % vorn (≥ ${MIN_N} Clips je Variante).`
    : `Kein klarer Gewinner: Unterschied ${lift ?? 0} % bei ≥ ${MIN_N} Clips je Variante.`;
  return { experiment: ex, variants, min_n: MIN_N, significant, leader: leader?.value ?? null, lift_pct: lift, hint };
}

/** Gewinner in die Nische schreiben (Diff → Bestätigung → putSettings) und Test beenden. */
export async function applyWinner(env: Env, value: string, confirm: boolean, ws = "default") {
  const ex = await getExperiment(env, ws);
  if (!ex) return { ok: false, error: "Kein A/B-Test aktiv" };
  if (!ex.variants.includes(value)) return { ok: false, error: `Wert ${value} gehört nicht zum Test` };
  const cur = await getSettings(env, ws);
  const next = JSON.parse(JSON.stringify(cur));
  const path = ex.variable.split("."); let o: any = next.niches[ex.niche];
  for (const k of path.slice(0, -1)) o = o[k] ??= {};
  const def = AB_VARIABLES[ex.variable];
  o[path.at(-1)!] = def?.kind === "number" ? Number(value) : value;
  for (const [id, a] of Object.entries(next.accounts as Record<string, any>)) {       // Account-Overrides derselben Variable entfernen, sonst greift der Gewinner dort nicht
    let x: any = a; for (const k of path.slice(0, -1)) x = x?.[k];
    if (x && path.at(-1)! in x) { delete x[path.at(-1)!]; void id; }
  }
  const errors = validateSettings(next);
  if (errors.length) return { ok: false, errors };
  const diff = diffSettings(env, cur, next);
  if (!confirm) return { ok: false, preview: true, diff, target: `${ex.variable} = ${value}` };
  const r = diff.length ? await putSettings(env, next, ws, diff) : { version: null };
  await stopExperiment(env, ws, `Gewinner ${value} übernommen`);
  await logEvent(env, `ab_applied ${ex.variable}=${value} niche=${ex.niche} changes=${diff.length}`);
  return { ok: true, ...r, diff };
}
