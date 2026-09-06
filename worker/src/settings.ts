// Einstellungen: global → Nische → Account-Override (leer = erbt). Quelle der Wahrheit ist D1 (settings), Defaults kommen aus
// config/accounts.yaml (ACCOUNTS_JSON) und config/brand.yaml-Werten. Die Pipeline liest GET /api/settings/effective?account=…
// und verdrahtet cut/select/visual/audio/caption/qa; der Publisher liest posts_per_day/slots/min_gap_min/mode/fan_ratio/platforms.
import { Env, db, nichesOf } from "./shared";
import { accountsOf } from "./publisher";

export interface NicheSettings {
  mode: "auto" | "review"; platforms: string[]; posts_per_day: number; slots: string[]; min_gap_min: number; fan_ratio: number;
  cut: { min_s: number; max_s: number; cold_open: boolean; pad_start_ms: number; pad_end_ms: number; silence_trim_s: number; word_boundary: boolean; end_style: "freeze" | "cut" | "none" };
  select: { candidates: number; render_top: number; dedupe_s: number; weights: Record<string, number>; min_score: number; context_line: boolean };
  visual: { font: string; color: string; accent: string; outline_px: number; hook_y_pct: number; hook_max_words: number; hook_max_lines: number; zoom_pct: number;
            zoom_max_per_clip: number; zoom_ease_ms: number; safe_top_px: number; safe_bottom_px: number; safe_right_px: number; cover_text: boolean;
            // Feinjustierung Hook-Text (Dashboard v4): Größe in px bei 1080 Breite, Dicke nur bei variablen Fonts (Montserrat, Oswald)
            hook_size: number; hook_weight: number; hook_spacing: number; hook_line_h: number; hook_align: "left" | "center" | "right"; hook_x_pct: number; hook_w_pct: number;
            hook_case: "upper" | "none"; box: "none" | "solid" | "blur"; box_color: string; box_opacity: number; box_pad: number; box_radius: number; shadow: number;
            anim: "none" | "pop" | "slide" | "typewriter"; accent_mode: "none" | "last2" | "first" | "keyword"; align?: string };
  audio: { lufs: number; true_peak: number; normalize: boolean };
  caption: { template: string; hashtags: string[]; pinned_comment: boolean; tone: string };
  qa: { threshold: number; checks: Record<string, boolean> };
}
export interface Settings { global: { shadow: boolean; workspace?: string }; niches: Record<string, NicheSettings>; accounts: Record<string, Partial<NicheSettings> | Record<string, any>> }

const BRAND: Record<string, Partial<NicheSettings["visual"]>> = {           // aus config/brand.yaml (Stufe 2)
  A: { font: "Anton", color: "#FFFFFF", accent: "#FF6A00", hook_align: "center", box: "none", accent_mode: "keyword" },
  B: { font: "Bangers", color: "#FFD400", accent: "#7B2FF7", hook_align: "left", box: "solid", box_color: "#7B2FF7", box_opacity: 100, accent_mode: "none" },
};
export const HOOK_DEFAULTS: Pick<NicheSettings["visual"], "hook_size" | "hook_weight" | "hook_spacing" | "hook_line_h" | "hook_align" | "hook_x_pct" | "hook_w_pct" | "hook_case" | "box" | "box_color" | "box_opacity" | "box_pad" | "box_radius" | "shadow" | "anim" | "accent_mode"> = {
  hook_size: 52, hook_weight: 800, hook_spacing: -1, hook_line_h: 1.05, hook_align: "center", hook_x_pct: 50, hook_w_pct: 84, hook_case: "upper",
  box: "none", box_color: "#000000", box_opacity: 55, box_pad: 10, box_radius: 10, shadow: 2, anim: "pop", accent_mode: "last2",
};
/** Altformat (box:true/false, align) → v4-Felder. */
function normalizeVisual(v: any): any {
  if (!v || typeof v !== "object") return v;
  const o = { ...v };
  if (typeof o.box === "boolean") o.box = o.box ? "solid" : "none";
  if (o.align && !o.hook_align) o.hook_align = o.align;
  delete o.align;
  return o;
}

export function defaultNiche(env: Env, key: string): NicheSettings {
  const n = nichesOf(env).find((x) => x.key === key);
  const acc = accountsOf(env);
  const first = n?.accounts?.[0] ?? "A";
  const cap = n?.caption ?? "Credit @mrbeast", tags = n?.hashtags ?? ["#mrbeast"];
  return {
    mode: "auto", platforms: ["tiktok"], posts_per_day: Number(env.MAX_CLIPS_PER_DAY || 5), slots: acc[first]?.slots ?? ["08:00", "11:30", "15:00", "18:30", "22:00"],
    min_gap_min: Number(env.POST_GAP_MIN || 90), fan_ratio: 60,
    cut: { min_s: 15, max_s: 35, cold_open: true, pad_start_ms: 120, pad_end_ms: 250, silence_trim_s: 0.6, word_boundary: true, end_style: "freeze" },
    select: { candidates: 20, render_top: 8, dedupe_s: 25, weights: { surprise: 2, stakes: 2, reaction: 1, cliffhanger: 2, context: 2, clarity: 2 }, min_score: 7, context_line: true },
    visual: { font: "Anton", color: "#FFFFFF", accent: "#FF6A00", outline_px: 5, hook_y_pct: 68, hook_max_words: 8, hook_max_lines: 2, zoom_pct: 8, zoom_max_per_clip: 2, zoom_ease_ms: 400,
              safe_top_px: 140, safe_bottom_px: 400, safe_right_px: 180, cover_text: true, ...HOOK_DEFAULTS },
    audio: { lufs: -14, true_peak: -1.5, normalize: true },
    caption: { template: `{hook} · ${cap} ${tags.join(" ")}`.trim(), hashtags: tags, pinned_comment: true, tone: "knapp" },
    qa: { threshold: 7, checks: { hook_legible: true, no_overlap: true, face_in_frame: true, not_blurry: true, safe_zone: true } },
  };
}

const deepMerge = (a: any, b: any): any => {
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
      for (const c of ["color", "accent", "box_color"]) if (v[c] !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(v[c]))) errs.push(`${where}.visual.${c}: Hex-Farbe`); }
    if (n.audio) { if (n.audio.lufs !== undefined) num(n.audio.lufs, -24, -8, `${where}.audio.lufs`, errs); if (n.audio.true_peak !== undefined) num(n.audio.true_peak, -6, 0, `${where}.audio.true_peak`, errs); }
    if (n.qa?.threshold !== undefined) num(n.qa.threshold, 0, 10, `${where}.qa.threshold`, errs);
    if (n.caption?.template !== undefined && !String(n.caption.template).includes("{hook}")) errs.push(`${where}.caption.template muss {hook} enthalten`);
    void partial;
  };
  for (const [k, n] of Object.entries(s.niches ?? {})) checkNiche(n, `niches.${k}`);
  for (const [k, n] of Object.entries(s.accounts ?? {})) checkNiche(n, `accounts.${k}`, true);
  return errs;
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
