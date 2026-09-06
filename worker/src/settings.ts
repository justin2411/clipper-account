// Einstellungen: global → Nische → Account-Override (leer = erbt). Quelle der Wahrheit ist D1 (settings), Defaults kommen aus
// config/accounts.yaml (ACCOUNTS_JSON) und config/brand.yaml-Werten. Die Pipeline liest GET /api/settings/effective?account=…
// und verdrahtet cut/select/visual/audio/caption/qa; der Publisher liest posts_per_day/slots/min_gap_min/mode/fan_ratio/platforms.
import { Env, db, nichesOf } from "./shared";
import { accountsOf } from "./publisher";

export interface NicheSettings {
  mode: "auto" | "review"; platforms: string[]; posts_per_day: number; slots: string[]; min_gap_min: number; fan_ratio: number;
  stock_days: number;                     // „Vorrat in Tagen“: fällt der Fan-Vorrat darunter, zieht das System den obersten Vorschlag (suggest.ts)
  cut: { min_s: number; max_s: number; cold_open: boolean; pad_start_ms: number; pad_end_ms: number; silence_trim_s: number; word_boundary: boolean; end_style: "freeze" | "cut" | "none" };
  select: { candidates: number; render_top: number; dedupe_s: number; weights: Record<string, number>; min_score: number; context_line: boolean };
  visual: { font: string; color: string; accent: string; outline_px: number; hook_y_pct: number; hook_max_words: number; hook_max_lines: number; zoom_pct: number;
            zoom_max_per_clip: number; zoom_ease_ms: number; safe_top_px: number; safe_bottom_px: number; safe_right_px: number; cover_text: boolean;
            // Feinjustierung Hook-Text (Dashboard v4): Größe in px bei 1080 Breite, Dicke nur bei variablen Fonts (Montserrat, Oswald)
            hook_size: number; hook_weight: number; hook_spacing: number; hook_line_h: number; hook_align: "left" | "center" | "right"; hook_x_pct: number; hook_w_pct: number;
            hook_case: "upper" | "none"; hook_sample: string;                 // hook_sample: nur Vorschautext im Dashboard, wird nie gerendert
            box: "none" | "solid" | "blur"; box_color: string; box_opacity: number; box_pad: number; box_radius: number; shadow: number;
            anim: "none" | "pop" | "slide" | "typewriter"; accent_mode: "none" | "last2" | "first" | "keyword"; align?: string;
            // Overlay oben (Pflichttext der Kampagne) – eigener Layer, erbt nichts vom Hook
            overlay: OverlaySettings; cover: CoverSettings };
  montage: { enabled: boolean; segments_min: number; segments_max: number; total_min_s: number; total_max_s: number;
             apart_min_s: number; part_max_s: number; punch_min_pct: number; punch_max_pct: number; punches_max: number;
             subtitles: boolean; sub_baseline_pct: number; sub_words: number };
  audio: { lufs: number; true_peak: number; normalize: boolean };
  caption: { template: string; hashtags: string[]; pinned_comment: boolean; tone: string };
  qa: { threshold: number; checks: Record<string, boolean> };
}
export interface OverlaySettings {
  show: "auto" | "always" | "never";      // auto = nur wenn die Kampagne einen Pflichttext vorgibt
  text: string;                            // leer = Kampagnentext bzw. Kontext-Zeile
  font: string; size: number; weight: number; color: string; case: "upper" | "none";
  y_pct: number; x_pct: number; w_pct: number; align: "left" | "center" | "right"; lines: number;
  box: "none" | "solid" | "blur"; box_color: string; box_opacity: number; box_pad: number; box_radius: number;
  outline_px: number; shadow: number; anim: "none" | "fade" | "slide"; duration: number;   // duration 0 = ganzer Clip
}
export interface CoverSettings {
  mode: "hook" | "custom" | "none";        // none = nur Bild
  text: string; font: string; size: number; weight: number; color: string; accent: string; case: "upper" | "none";
  align: "left" | "center" | "right"; y_pct: number; x_pct: number; w_pct: number; max_words: number; lines: number;
  outline_px: number; shadow: number; box: "none" | "solid" | "blur"; box_color: string; box_opacity: number; box_pad: number; box_radius: number;
  frame: "motion" | "face" | "first" | "manual"; frame_skip_s: number; dim: number;
}
export interface Settings { global: { shadow: boolean; workspace?: string }; niches: Record<string, NicheSettings>; accounts: Record<string, Partial<NicheSettings> | Record<string, any>> }

const BRAND: Record<string, Partial<NicheSettings["visual"]>> = {           // aus config/brand.yaml (Stufe 2)
  A: { font: "Anton", color: "#FFFFFF", accent: "#FF6A00", hook_align: "center", box: "none", accent_mode: "keyword" },
  B: { font: "Bangers", color: "#FFD400", accent: "#7B2FF7", hook_align: "left", box: "solid", box_color: "#7B2FF7", box_opacity: 100, accent_mode: "none" },
};
export const HOOK_DEFAULTS: Pick<NicheSettings["visual"], "hook_sample" | "hook_size" | "hook_weight" | "hook_spacing" | "hook_line_h" | "hook_align" | "hook_x_pct" | "hook_w_pct" | "hook_case" | "box" | "box_color" | "box_opacity" | "box_pad" | "box_radius" | "shadow" | "anim" | "accent_mode"> = {
  hook_sample: "", hook_size: 52, hook_weight: 800, hook_spacing: -1, hook_line_h: 1.05, hook_align: "center", hook_x_pct: 50, hook_w_pct: 84, hook_case: "upper",
  box: "none", box_color: "#000000", box_opacity: 55, box_pad: 10, box_radius: 10, shadow: 2, anim: "pop", accent_mode: "last2",
};
export const OVERLAY_DEFAULTS: OverlaySettings = {
  show: "auto", text: "", font: "Montserrat", size: 34, weight: 700, color: "#FFFFFF", case: "none",
  y_pct: 14, x_pct: 50, w_pct: 84, align: "center", lines: 2,
  box: "solid", box_color: "#000000", box_opacity: 55, box_pad: 10, box_radius: 10,
  outline_px: 2, shadow: 1, anim: "fade", duration: 0,
};
export const COVER_DEFAULTS: CoverSettings = {
  mode: "hook", text: "", font: "Anton", size: 92, weight: 800, color: "#FFFFFF", accent: "#FF6A00", case: "upper",
  align: "center", y_pct: 45, x_pct: 50, w_pct: 78, max_words: 6, lines: 3,
  outline_px: 8, shadow: 2, box: "none", box_color: "#000000", box_opacity: 55, box_pad: 14, box_radius: 14,
  frame: "motion", frame_skip_s: 1, dim: 15,
};

/** Altformat (box:true/false, align) → v4-Felder. */
function normalizeVisual(v: any): any {
  if (!v || typeof v !== "object") return v;
  const o = { ...v };
  if (typeof o.box === "boolean") o.box = o.box ? "solid" : "none";
  if (o.align && !o.hook_align) o.hook_align = o.align;
  delete o.align;
  if (o.overlay && typeof o.overlay.box === "boolean") o.overlay.box = o.overlay.box ? "solid" : "none";
  if (o.cover && typeof o.cover.box === "boolean") o.cover.box = o.cover.box ? "solid" : "none";
  return o;
}

export function defaultNiche(env: Env, key: string): NicheSettings {
  const n = nichesOf(env).find((x) => x.key === key);
  const acc = accountsOf(env);
  const first = n?.accounts?.[0] ?? "A";
  const cap = n?.caption ?? "Credit @mrbeast", tags = n?.hashtags ?? ["#mrbeast"];
  return {
    mode: "auto", platforms: ["tiktok"], posts_per_day: Number(env.MAX_CLIPS_PER_DAY || 5), slots: acc[first]?.slots ?? ["08:00", "11:30", "15:00", "18:30", "22:00"],
    min_gap_min: Number(env.POST_GAP_MIN || 90), fan_ratio: 60, stock_days: 2,
    cut: { min_s: 15, max_s: 35, cold_open: true, pad_start_ms: 120, pad_end_ms: 250, silence_trim_s: 0.6, word_boundary: true, end_style: "freeze" },
    select: { candidates: 20, render_top: 8, dedupe_s: 25, weights: { surprise: 2, stakes: 2, reaction: 1, cliffhanger: 2, context: 2, clarity: 2 }, min_score: 7, context_line: true },
    visual: { font: "Anton", color: "#FFFFFF", accent: "#FF6A00", outline_px: 5, hook_y_pct: 68, hook_max_words: 8, hook_max_lines: 2, zoom_pct: 8, zoom_max_per_clip: 2, zoom_ease_ms: 400,
              safe_top_px: 140, safe_bottom_px: 400, safe_right_px: 180, cover_text: true, ...HOOK_DEFAULTS,
              overlay: { ...OVERLAY_DEFAULTS }, cover: { ...COVER_DEFAULTS } },
    montage: { enabled: true, segments_min: 3, segments_max: 4, total_min_s: 22, total_max_s: 35, apart_min_s: 30,
               part_max_s: 4, punch_min_pct: 5, punch_max_pct: 8, punches_max: 2, subtitles: true, sub_baseline_pct: 72, sub_words: 4 },
    audio: { lufs: -14, true_peak: -1.5, normalize: true },
    caption: { template: `{hook} · ${cap} ${tags.join(" ")}`.trim(), hashtags: tags, pinned_comment: true, tone: "knapp" },
    qa: { threshold: 7, checks: { hook_legible: true, no_overlap: true, face_in_frame: true, not_blurry: true, safe_zone: true } },
  };
}

export const deepMerge = (a: any, b: any): any => {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object" || !a || !b) return b === undefined ? a : b;
  const out: any = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
};

/** Gesamtes Settings-Objekt (D1, mit Defaults aufgefüllt). */
export async function getSettings(env: Env, ws = "default"): Promise<Settings> {
  const rows = await db.all<{ key: string; value: string }>(env, "SELECT key, value FROM settings WHERE workspace_id = ?", ws);
  const val = (k: string) => { const r = rows.find((x) => x.key === k); try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
  const niches: Record<string, NicheSettings> = {};
  for (const n of nichesOf(env)) { const st = val(`niche:${n.key}`) ?? {}; if (st.visual) st.visual = normalizeVisual(st.visual); niches[n.key] = deepMerge(defaultNiche(env, n.key), st); }
  const accounts: Record<string, any> = {};
  for (const [id, a] of Object.entries(accountsOf(env))) {
    const stored = val(`account:${id}`);
    if (stored?.visual) stored.visual = normalizeVisual(stored.visual);
    accounts[id] = stored ?? (BRAND[id] ? { visual: { ...BRAND[id] }, slots: a.slots } : { slots: a.slots });
  }
  const g = val("global") ?? {};
  return { global: { shadow: g.shadow ?? ((env.PUBLISH_MODE_FAN ?? "").toLowerCase() === "shadow"), workspace: ws }, niches, accounts };
}

/** Standardwerte (ohne D1-Stände): Nischen-Defaults + Marken-Overrides A/B – Ziel von „Auf Standard zurücksetzen". */
export function defaultSettings(env: Env, ws = "default"): Settings {
  const niches: Record<string, NicheSettings> = {};
  for (const n of nichesOf(env)) niches[n.key] = defaultNiche(env, n.key);
  const accounts: Record<string, any> = {};
  for (const [id, a] of Object.entries(accountsOf(env))) accounts[id] = BRAND[id] ? { visual: { ...BRAND[id] }, slots: a.slots } : { slots: a.slots };
  return { global: { shadow: (env.PUBLISH_MODE_FAN ?? "").toLowerCase() === "shadow", workspace: ws }, niches, accounts };
}

/** Letzte 10 Stände (Stufe 3): id, Zeit, Anzahl Änderungen, Diff. */
export async function listVersions(env: Env, ws = "default"): Promise<{ id: number; created_at: string; changes: number; diff: unknown[] }[]> {
  const rows = await db.all<{ id: number; created_at: string; diff: string | null }>(env, "SELECT id, created_at, diff FROM settings_versions WHERE workspace_id = ? ORDER BY id DESC LIMIT 10", ws);
  return rows.map((r) => { const d = r.diff ? JSON.parse(r.diff) : []; return { id: r.id, created_at: r.created_at, changes: Array.isArray(d) ? d.length : 0, diff: Array.isArray(d) ? d.slice(0, 12) : [] }; });
}

export async function getVersion(env: Env, id: number, ws = "default"): Promise<Settings | null> {
  const r = await db.first<{ snapshot: string }>(env, "SELECT snapshot FROM settings_versions WHERE workspace_id = ? AND id = ?", ws, id);
  if (!r) return null;
  const s = JSON.parse(r.snapshot) as Settings;                         // ältere Stände: box:true/false, align → v4-Felder
  for (const n of Object.values(s.niches ?? {})) if ((n as any).visual) (n as any).visual = normalizeVisual((n as any).visual);
  for (const a of Object.values(s.accounts ?? {})) if ((a as any).visual) (a as any).visual = normalizeVisual((a as any).visual);
  return s;
}

/** Wirksame Einstellungen für einen Account: Nische + Override. */
export async function effectiveSettings(env: Env, account: string, ws = "default"): Promise<{ niche: string; settings: NicheSettings; shadow: boolean }> {
  const s = await getSettings(env, ws);
  const acc = accountsOf(env)[account];
  const nicheKey = acc?.niche ?? nichesOf(env).find((n) => n.accounts.includes(account))?.key ?? Object.keys(s.niches)[0];
  const base = s.niches[nicheKey] ?? defaultNiche(env, nicheKey);
  return { niche: nicheKey, settings: deepMerge(base, s.accounts[account] ?? {}), shadow: s.global.shadow };
}

const num = (v: any, lo: number, hi: number, name: string, errs: string[]) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) errs.push(`${name}: ${v} außerhalb ${lo}–${hi}`);
  return n;
};

const FONTS = ["Anton", "Bangers", "Bebas Neue", "Luckiest Guy", "Montserrat", "Oswald", "Archivo Black"];
const OVERLAY_RANGES: Record<string, [number, number]> = { size: [12, 72], weight: [400, 900], y_pct: [4, 40], x_pct: [0, 100], w_pct: [20, 100],
  lines: [1, 4], box_opacity: [0, 100], box_pad: [0, 40], box_radius: [0, 40], outline_px: [0, 10], shadow: [0, 6], duration: [0, 60] };
const OVERLAY_ENUMS: Record<string, string[]> = { show: ["auto", "always", "never"], case: ["upper", "none"], align: ["left", "center", "right"],
  box: ["none", "solid", "blur"], anim: ["none", "fade", "slide"], font: FONTS };
const COVER_RANGES: Record<string, [number, number]> = { size: [24, 160], weight: [400, 900], y_pct: [5, 90], x_pct: [0, 100], w_pct: [20, 100],
  max_words: [1, 12], lines: [1, 4], box_opacity: [0, 100], box_pad: [0, 40], box_radius: [0, 40], outline_px: [0, 14], shadow: [0, 8],
  frame_skip_s: [0, 30], dim: [0, 60] };
const COVER_ENUMS: Record<string, string[]> = { mode: ["hook", "custom", "none"], case: ["upper", "none"], align: ["left", "center", "right"],
  box: ["none", "solid", "blur"], frame: ["motion", "face", "first", "manual"], font: FONTS };

/** Ein Unterblock (overlay, cover): Zahlenbereiche, Auswahlfelder, Hex-Farben. */
function checkBlock(b: any, where: string, ranges: Record<string, [number, number]>, enums: Record<string, string[]>, colors: string[], errs: string[]) {
  if (b === undefined) return;
  if (!b || typeof b !== "object" || Array.isArray(b)) { errs.push(`${where}: Objekt erwartet`); return; }
  for (const [k, [lo, hi]] of Object.entries(ranges)) if (b[k] !== undefined) num(b[k], lo, hi, `${where}.${k}`, errs);
  for (const [k, ok] of Object.entries(enums)) if (b[k] !== undefined && !ok.includes(String(b[k]))) errs.push(`${where}.${k}: ${ok.join("|")}`);
  for (const c of colors) if (b[c] !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(b[c]))) errs.push(`${where}.${c}: Hex-Farbe`);
  // overlay.text darf farbige Teilstücke enthalten: <span style="color:#RRGGBB">…</span>. Alles andere an Auszeichnung wird abgelehnt,
  // der Renderer entfernt übrig gebliebene Tags. Mit den Spans ist der Text länger als der reine Inhalt, daher 400 Zeichen.
  if (b.text !== undefined) {
    const t = String(b.text);
    if (t.length > 400) errs.push(`${where}.text: höchstens 400 Zeichen`);
    const bare = t.replace(/<span style="color:\s*#[0-9a-fA-F]{3,6}\s*(?:;[^"]*)?">/g, "").replace(/<\/span>/g, "");
    if (/[<>]/.test(bare)) errs.push(`${where}.text: nur <span style="color:#RRGGBB"> für farbige Wörter erlaubt`);
    if (bare.length > 200) errs.push(`${where}.text: höchstens 200 Zeichen Text`);
  }
}

/** Validierung: bekannte Felder, Wertebereiche, Slots HH:MM. Rückgabe: Fehlerliste. */
export function validateSettings(s: Settings): string[] {
  const errs: string[] = [];
  const checkNiche = (n: any, where: string, partial = false) => {
    if (!n || typeof n !== "object") { errs.push(`${where}: Objekt erwartet`); return; }
    const has = (k: string) => n[k] !== undefined;
    if (has("mode") && !["auto", "review"].includes(n.mode)) errs.push(`${where}.mode: auto|review`);
    if (has("posts_per_day")) num(n.posts_per_day, 1, 8, `${where}.posts_per_day`, errs);
    if (has("min_gap_min")) num(n.min_gap_min, 30, 720, `${where}.min_gap_min`, errs);
    if (has("fan_ratio")) num(n.fan_ratio, 0, 100, `${where}.fan_ratio`, errs);
    if (has("stock_days")) num(n.stock_days, 1, 14, `${where}.stock_days`, errs);
    if (has("slots")) { if (!Array.isArray(n.slots) || n.slots.some((x: any) => !/^\d{2}:\d{2}$/.test(String(x)))) errs.push(`${where}.slots: Liste HH:MM`); }
    if (has("platforms") && (!Array.isArray(n.platforms) || n.platforms.some((p: any) => !["tiktok", "instagram", "youtube"].includes(p)))) errs.push(`${where}.platforms`);
    if (n.cut) { if (n.cut.min_s !== undefined) num(n.cut.min_s, 5, 90, `${where}.cut.min_s`, errs); if (n.cut.max_s !== undefined) num(n.cut.max_s, 8, 180, `${where}.cut.max_s`, errs);
      if (n.cut.min_s !== undefined && n.cut.max_s !== undefined && Number(n.cut.min_s) >= Number(n.cut.max_s)) errs.push(`${where}.cut: min_s < max_s`);
      if (n.cut.end_style !== undefined && !["freeze", "cut", "none"].includes(n.cut.end_style)) errs.push(`${where}.cut.end_style`); }
    if (n.select) { if (n.select.candidates !== undefined) num(n.select.candidates, 5, 40, `${where}.select.candidates`, errs); if (n.select.render_top !== undefined) num(n.select.render_top, 1, 16, `${where}.select.render_top`, errs);
      if (n.select.min_score !== undefined) num(n.select.min_score, 0, 12, `${where}.select.min_score`, errs);
      if (n.select.weights) for (const [k, v] of Object.entries(n.select.weights)) num(v, 0, 3, `${where}.select.weights.${k}`, errs); }
    if (n.visual) { if (n.visual.hook_y_pct !== undefined) num(n.visual.hook_y_pct, 40, 72, `${where}.visual.hook_y_pct`, errs); if (n.visual.zoom_pct !== undefined) num(n.visual.zoom_pct, 0, 15, `${where}.visual.zoom_pct`, errs);
      if (n.visual.hook_max_words !== undefined) num(n.visual.hook_max_words, 3, 12, `${where}.visual.hook_max_words`, errs);
      const v = n.visual, ranges: Record<string, [number, number]> = { hook_size: [28, 96], hook_weight: [400, 900], hook_spacing: [-3, 4], hook_line_h: [0.8, 1.6], hook_x_pct: [0, 100], hook_w_pct: [30, 100],
        box_opacity: [0, 100], box_pad: [0, 40], box_radius: [0, 40], shadow: [0, 6], outline_px: [0, 12], hook_max_lines: [1, 3] };
      for (const [k, [lo, hi]] of Object.entries(ranges)) if (v[k] !== undefined) num(v[k], lo, hi, `${where}.visual.${k}`, errs);
      const enums: Record<string, string[]> = { hook_align: ["left", "center", "right"], hook_case: ["upper", "none"], box: ["none", "solid", "blur"], anim: ["none", "pop", "slide", "typewriter"], accent_mode: ["none", "last2", "first", "keyword"],
        font: ["Anton", "Bangers", "Bebas Neue", "Luckiest Guy", "Montserrat", "Oswald", "Archivo Black"] };
      for (const [k, ok] of Object.entries(enums)) if (v[k] !== undefined && !ok.includes(String(v[k]))) errs.push(`${where}.visual.${k}: ${ok.join("|")}`);
      for (const c of ["color", "accent", "box_color"]) if (v[c] !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(v[c]))) errs.push(`${where}.visual.${c}: Hex-Farbe`);
      if (v.hook_sample !== undefined && String(v.hook_sample).length > 200) errs.push(`${where}.visual.hook_sample: höchstens 200 Zeichen`);
      checkBlock(v.overlay, `${where}.visual.overlay`, OVERLAY_RANGES, OVERLAY_ENUMS, ["color", "box_color"], errs);
      checkBlock(v.cover, `${where}.visual.cover`, COVER_RANGES, COVER_ENUMS, ["color", "accent", "box_color"], errs); }
    if (n.montage) {
      const m = n.montage, r: Record<string, [number, number]> = { segments_min: [2, 4], segments_max: [3, 6], total_min_s: [10, 40],
        total_max_s: [15, 60], apart_min_s: [0, 300], part_max_s: [2, 10], punch_min_pct: [0, 20], punch_max_pct: [0, 25],
        punches_max: [0, 6], sub_baseline_pct: [50, 80], sub_words: [2, 6] };
      for (const [k, [lo, hi]] of Object.entries(r)) if (m[k] !== undefined) num(m[k], lo, hi, `${where}.montage.${k}`, errs);
      if (m.total_min_s !== undefined && m.total_max_s !== undefined && Number(m.total_min_s) >= Number(m.total_max_s)) errs.push(`${where}.montage: total_min_s < total_max_s`);
    }
    if (n.audio) { if (n.audio.lufs !== undefined) num(n.audio.lufs, -24, -8, `${where}.audio.lufs`, errs); if (n.audio.true_peak !== undefined) num(n.audio.true_peak, -6, 0, `${where}.audio.true_peak`, errs); }
    if (n.qa?.threshold !== undefined) num(n.qa.threshold, 0, 10, `${where}.qa.threshold`, errs);
    if (n.caption?.template !== undefined && !String(n.caption.template).includes("{hook}")) errs.push(`${where}.caption.template muss {hook} enthalten`);
    void partial;
  };
  for (const [k, n] of Object.entries(s.niches ?? {})) checkNiche(n, `niches.${k}`);
  for (const [k, n] of Object.entries(s.accounts ?? {})) checkNiche(n, `accounts.${k}`, true);
  return errs;
}

/** Praktische Tageslimits je Plattform – mehr Posts schadet der Reichweite mehr, als es bringt. */
export const PLATFORM_MAX_PER_DAY: Record<string, number> = { tiktok: 10, instagram: 10, youtube: 5 };

/** Harte Prüfungen gegen die laufenden Kampagnen (die Warnungen aus dem Dashboard, serverseitig durchgesetzt).
 *  1. Hook-Höhe höchstens 72 % (sonst verdeckt TikToks Caption-Leiste den Text) – der Bereich steckt schon in validateSettings.
 *  2. cut.min_s nie unter der Mindestlänge einer aktiven Kampagne der Nische.
 *  3. overlay.show = never, obwohl eine aktive Kampagne einen Pflichttext vorgibt → abgelehnt.
 *  4. posts_per_day höchstens so hoch wie das Limit der schwächsten gewählten Plattform. */
export async function validateAgainstCampaigns(env: Env, s: Settings, ws = "default"): Promise<string[]> {
  const errs: string[] = [];
  const rows = await db.all<{ niche_id: string | null; name: string; min_seconds: number | null; required: string | null }>(env,
    "SELECT niche_id, name, min_seconds, required FROM campaigns WHERE workspace_id = ? AND COALESCE(status,'active') IN ('active','joined') AND COALESCE(kind,'paid') = 'paid'", ws).catch(() => []);
  const overlayTextOf = (r: { required: string | null }) => { try { return String((JSON.parse(r.required || "{}") as any)?.overlay_text ?? "").trim(); } catch { return ""; } };
  const forNiche = (key: string | null) => rows.filter((r) => !key || !r.niche_id || r.niche_id === key);
  const nicheOfAccount = (id: string) => (accountsOf(env)[id] as any)?.niche ?? nichesOf(env).find((n) => n.accounts.includes(id))?.key ?? null;

  const check = (part: any, where: string, nicheKey: string | null, base: any) => {
    if (!part || typeof part !== "object") return;
    const camps = forNiche(nicheKey);
    const minS = part.cut?.min_s ?? base?.cut?.min_s;
    if (minS !== undefined) {
      const longest = camps.reduce((a, r) => Math.max(a, Number(r.min_seconds ?? 0)), 0);
      const who = camps.filter((r) => Number(r.min_seconds ?? 0) === longest && longest > 0).map((r) => r.name)[0];
      if (longest > 0 && Number(minS) < longest) errs.push(`${where}.cut.min_s: ${minS} s liegt unter der Mindestlänge der Kampagne „${who}" (${longest} s)`);
    }
    const show = part.visual?.overlay?.show ?? base?.visual?.overlay?.show;
    if (show === "never") {
      const withText = camps.filter((r) => overlayTextOf(r)).map((r) => r.name);
      if (withText.length) errs.push(`${where}.visual.overlay.show: „never" nicht möglich – ${withText.slice(0, 2).join(", ")} schreibt einen Pflichttext vor`);
    }
    const ppd = part.posts_per_day ?? base?.posts_per_day;
    const platforms: string[] = part.platforms ?? base?.platforms ?? ["tiktok"];
    if (ppd !== undefined && Array.isArray(platforms) && platforms.length) {
      const limit = Math.min(...platforms.map((pl) => PLATFORM_MAX_PER_DAY[pl] ?? 10));
      const worst = platforms.find((pl) => (PLATFORM_MAX_PER_DAY[pl] ?? 10) === limit);
      if (Number(ppd) > limit) errs.push(`${where}.posts_per_day: ${ppd} über dem Limit von ${worst} (${limit} pro Tag)`);
    }
  };
  for (const [k, n] of Object.entries(s.niches ?? {})) check(n, `niches.${k}`, k, null);
  for (const [k, n] of Object.entries(s.accounts ?? {})) { const key = nicheOfAccount(k); check(n, `accounts.${k}`, key, key ? s.niches?.[key] : null); }
  return errs;
}

/** Beide Prüfungen: Wertebereiche (immer) und die harten Kampagnenregeln.
 *  Blockiert wird nur, was dieser Speichervorgang neu einbringt – ein Verstoß, der im gespeicherten Stand schon steckt,
 *  kommt als Warnung zurück, sonst ließe sich nichts mehr ändern, bis er behoben ist. */
export async function validateAll(env: Env, next: Settings, ws = "default", cur?: Settings): Promise<{ errors: string[]; warnings: string[] }> {
  const base = validateSettings(next);
  const now = await validateAgainstCampaigns(env, next, ws);
  const before = cur ? await validateAgainstCampaigns(env, cur, ws) : [];
  const old = new Set(before);
  return { errors: [...base, ...now.filter((e) => !old.has(e))], warnings: now.filter((e) => old.has(e)) };
}

/** Diff zwischen zwei Settings-Objekten: [{field, old, new, accounts}] – für Bestätigung vor dem Schreiben (Stufe 3). */
export function diffSettings(env: Env, a: Settings, b: Settings): { field: string; old: unknown; new: unknown; accounts: string[] }[] {
  const out: { field: string; old: unknown; new: unknown; accounts: string[] }[] = [];
  const walk = (x: any, y: any, path: string, accounts: string[]) => {
    const keys = new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})]);
    for (const k of keys) {
      const xv = x?.[k], yv = y?.[k], p = path ? `${path}.${k}` : k;
      if (xv && yv && typeof xv === "object" && typeof yv === "object" && !Array.isArray(xv) && !Array.isArray(yv)) walk(xv, yv, p, accounts);
      else if (JSON.stringify(xv) !== JSON.stringify(yv)) out.push({ field: p, old: xv, new: yv, accounts });
    }
  };
  const nichesCfg = nichesOf(env);
  walk(a.global, b.global, "global", Object.keys(accountsOf(env)));
  for (const k of new Set([...Object.keys(a.niches ?? {}), ...Object.keys(b.niches ?? {})])) walk(a.niches?.[k], b.niches?.[k], `niches.${k}`, nichesCfg.find((n) => n.key === k)?.accounts ?? []);
  for (const k of new Set([...Object.keys(a.accounts ?? {}), ...Object.keys(b.accounts ?? {})])) walk(a.accounts?.[k], b.accounts?.[k], `accounts.${k}`, [k]);
  return out;
}

/** Schreiben (nach Validierung): D1 + Version; optional YAML-Export ins Repo (GitHub Contents API, best effort). */
export async function putSettings(env: Env, s: Settings, ws = "default", diff: unknown = null): Promise<{ version: number }> {
  const now = new Date().toISOString();
  const up = async (key: string, value: unknown) =>
    db.run(env, "INSERT INTO settings (workspace_id, key, value, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, version = settings.version + 1, updated_at = excluded.updated_at",
      ws, key, JSON.stringify(value), now);
  await up("global", { shadow: !!s.global?.shadow });
  for (const [k, n] of Object.entries(s.niches ?? {})) await up(`niche:${k}`, n);
  for (const [k, n] of Object.entries(s.accounts ?? {})) await up(`account:${k}`, n);
  await db.run(env, "INSERT INTO settings_versions (workspace_id, snapshot, diff) VALUES (?, ?, ?)", ws, JSON.stringify(s), diff ? JSON.stringify(diff) : null);
  await db.run(env, "DELETE FROM settings_versions WHERE workspace_id = ? AND id NOT IN (SELECT id FROM settings_versions WHERE workspace_id = ? ORDER BY id DESC LIMIT 10)", ws, ws);
  const v = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM settings_versions WHERE workspace_id = ?", ws);
  await exportYaml(env, s).catch((e) => console.log("[settings] yaml export", e?.message ?? e));
  return { version: v?.n ?? 1 };
}

/** config/niches/<key>.yaml + config/niches/overrides.yaml im Repo aktualisieren (GitHub Contents API). Scheitert leise ohne Contents-Recht. */
async function exportYaml(env: Env, s: Settings) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;
  const H = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "clipforge-worker", "Content-Type": "application/json" };
  const files: Record<string, unknown> = {};
  for (const [k, n] of Object.entries(s.niches)) files[`config/niches/${k}.yaml`] = n;
  files["config/niches/overrides.yaml"] = { accounts: s.accounts, global: s.global };
  for (const [path, obj] of Object.entries(files)) {
    const body = "# Von der Dashboard-Feinjustierung geschrieben (Quelle der Wahrheit: D1 settings). Nicht von Hand ändern.\n" + toYaml(obj);
    const cur = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_REF || "main"}`, { headers: H });
    const sha = cur.ok ? ((await cur.json()) as any).sha : undefined;
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, { method: "PUT", headers: H,
      body: JSON.stringify({ message: `settings: ${path} aus dem Dashboard [skip ci]`, content: btoa(unescape(encodeURIComponent(body))), branch: env.GITHUB_REF || "main", ...(sha ? { sha } : {}) }) });
    if (!r.ok) { console.log("[settings] github", r.status, (await r.text()).slice(0, 120)); return; }
  }
}

function toYaml(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(v)) return v.length ? v.map((x) => `${pad}- ${typeof x === "object" ? toYaml(x, indent + 1).trimStart() : yamlScalar(x)}`).join("\n") : `${pad}[]`;
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) =>
    x && typeof x === "object" ? `${pad}${k}:\n${toYaml(x, indent + 1)}` : `${pad}${k}: ${yamlScalar(x)}`).join("\n");
  return `${pad}${yamlScalar(v)}`;
}
const yamlScalar = (x: unknown) => typeof x === "string" ? JSON.stringify(x) : String(x);
