// Gemeinsame Helfer: Env-Typen, D1-Zugriff, Telegram, Blotato, JSON-Antworten.

export interface Env {
  DB: D1Database;
  CLIPS: R2Bucket;
  // vars (wrangler.toml)
  BLOTATO_DRAFT?: string;            // veraltet – PUBLISH_MODE=draft
  PUBLISH_MODE?: string;             // live | shadow | draft (paid-Kampagnen)
  PUBLISH_MODE_FAN?: string;         // live | shadow | draft (Fan-Content; leer = wie PUBLISH_MODE)
  MAX_CLIPS_PER_DAY?: string;        // Posts je Account und Tag (Dauerbetrieb)
  POST_GAP_MIN?: string;             // Kollisionsschutz über alle Quellen/Accounts (Minuten)
  RAMP_DAYS?: string;                // neue Accounts: erste N Tage …
  RAMP_MAX_PER_DAY?: string;         // … höchstens so viele Posts/Tag
  PAID_SLOTS_PER_DAY?: string;       // aktive paid-Kampagne ersetzt so viele Fan-Slots je Account/Tag
  PAID_SLOTS_PER_DAY_MULTI?: string; // … bei mehreren paid-Kampagnen
  STOCK_DAYS?: string;               // Vorproduktion: Vorrat fertiger Clips in Tagen
  PLATFORM_GAP_MIN?: string;
  GITHUB_REPO?: string;
  GITHUB_REF?: string;
  PUBLIC_ORIGIN?: string;            // öffentliche Worker-URL (Media-Links in Cron-Läufen)
  DASHBOARD_URL?: string;            // Pages-URL (Links in Telegram-Berichten)
  // secrets
  CLIPFORGE_API_KEY?: string;
  DASHBOARD_READ_KEY?: string;
  BLOTATO_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  GITHUB_TOKEN?: string;
  ACCOUNTS_JSON?: string;
}

export type Row = Record<string, unknown>;

export const nowIso = () => new Date().toISOString();

export const parseJson = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string" || !v) return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};

export type PublishMode = "live" | "shadow" | "draft";
/** Betriebsmodus des Publishers: PUBLISH_MODE, sonst (alt) BLOTATO_DRAFT. */
export const publishMode = (env: Env, kind: string | null = "paid"): PublishMode => {
  const pick = (v?: string): PublishMode | null => { const m = (v ?? "").toLowerCase(); return m === "live" || m === "shadow" || m === "draft" ? m : null; };
  if (kind === "fan") { const f = pick(env.PUBLISH_MODE_FAN); if (f) return f; }
  return pick(env.PUBLISH_MODE) ?? ((env.BLOTATO_DRAFT ?? "true") === "true" ? "draft" : "live");
};

export interface Campaign {
  id: string; platform: string; name: string; kind: "paid" | "fan"; external_url: string | null; status: string;
  rate_per_1k_usd: number | null; min_views: number; max_per_post_usd: number | null; min_seconds: number;
  footage: { type?: string; url?: string }; required: Record<string, any>; forbidden: Record<string, any>;
  accounts: string[]; platforms: string[]; created_at: string;
}

/** D1-Zeile → Kampagne mit geparsten JSON-Feldern. */
export const toCampaign = (r: Row): Campaign => ({
  ...(r as any),
  footage: parseJson(r.footage, {}),
  required: parseJson(r.required, {}),
  forbidden: parseJson(r.forbidden, {}),
  accounts: parseJson(r.accounts, ["A", "B"]),
  platforms: parseJson(r.platforms, ["tiktok"]),
});

export const db = {
  all: async <T = Row>(env: Env, sql: string, ...params: unknown[]): Promise<T[]> =>
    (await env.DB.prepare(sql).bind(...params).all<T>()).results ?? [],
  first: async <T = Row>(env: Env, sql: string, ...params: unknown[]): Promise<T | null> =>
    (await env.DB.prepare(sql).bind(...params).first<T>()) ?? null,
  run: (env: Env, sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run(),
};

export const logEvent = (env: Env, event: string, campaignId: string | null = null) =>
  db.run(env, "INSERT INTO events (campaign_id, event) VALUES (?, ?)", campaignId, event);

/** Telegram-Foto per URL (z.B. Standbild aus R2) mit Bildunterschrift. */
export async function telegramPhoto(env: Env, photoUrl: string, caption: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, photo: photoUrl, caption: caption.slice(0, 1024) }),
  });
  if (!r.ok) console.log("[telegram] photo Fehler", r.status, await r.text());
  return r.ok;
}

/** Telegram-Nachricht; ohne Token/Chat-ID nur Log (Einrichtung darf nicht blockieren). */
export async function telegram(env: Env, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { console.log("[telegram] nicht konfiguriert:", text.slice(0, 120)); return false; }
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!r.ok) console.log("[telegram] Fehler", r.status, await r.text());
  return r.ok;
}

export interface Niche { key: string; label: string; color: string; accounts: string[]; caption: string; hashtags: string[]; channels: Record<string, string> }
/** Nischen aus ACCOUNTS_JSON._niches (config/accounts.yaml → scripts/accounts_json.py). */
export const nichesOf = (env: Env): Niche[] => {
  try {
    const all = JSON.parse(env.ACCOUNTS_JSON || "{}");
    return Object.entries((all._niches ?? {}) as Record<string, any>).map(([key, n]) => ({
      key, label: n.label ?? key, color: n.color ?? "#8B5CF6", accounts: n.accounts ?? [], caption: n.caption ?? "", hashtags: n.hashtags ?? [], channels: n.channels ?? {} }));
  } catch { return []; }
};
export const nicheOfAccount = (env: Env, account: string): Niche | undefined => nichesOf(env).find((n) => n.accounts.includes(account));

/** Dashboard-Lese-Key oder API-Key (zeitkonstant verglichen). */
export function keyMatches(given: string, key?: string): boolean {
  if (!key) return false;
  let diff = key.length ^ given.length;
  for (let i = 0; i < key.length && i < given.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export const BLOTATO = "https://backend.blotato.com/v2";
export const blotatoHeaders = (env: Env) => ({ "blotato-api-key": env.BLOTATO_API_KEY ?? "", "Content-Type": "application/json" });

export const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/** Öffentliche URL eines R2-Objekts, ausgeliefert über diesen Worker (GET /media/<key>). */
export const mediaUrl = (origin: string, key: string) => `${origin}/media/${key.split("/").map(encodeURIComponent).join("/")}`;
export const mediaKeyFromUrl = (url: string): string | null => {
  const i = url.indexOf("/media/");
  return i < 0 ? null : decodeURIComponent(url.slice(i + 7));
};

// ---------- TikTok-Zahlen direkt von der Profil-/Videoseite (öffentlich eingebettetes JSON), kein Login nötig ----------
const TT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const ttNum = (html: string, key: string): number | null => {
  const m = html.match(new RegExp(`"${key}":"?(\\d+)"?`));
  return m ? Number(m[1]) : null;
};
/** Profil: Follower, Likes gesamt (heartCount), Videos. null, wenn TikTok die Seite nicht liefert (Bot-Schutz). */
export async function tiktokProfile(handle: string): Promise<{ followers: number; likes_total: number; videos: number; following: number } | null> {
  const h = handle.replace(/^@/, "");
  try {
    const r = await fetch(`https://www.tiktok.com/@${h}`, { headers: { "User-Agent": TT_UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html" }, redirect: "follow" });
    if (!r.ok) return null;
    const html = await r.text();
    const followers = ttNum(html, "followerCount"), likes = ttNum(html, "heartCount");
    if (followers == null || likes == null) return null;
    return { followers, likes_total: likes, videos: ttNum(html, "videoCount") ?? 0, following: ttNum(html, "followingCount") ?? 0 };
  } catch { return null; }
}
/** Video: Views (playCount), Likes (diggCount), Kommentare, Shares. */
export async function tiktokVideo(url: string): Promise<{ views: number; likes: number; comments: number; shares: number } | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": TT_UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html" }, redirect: "follow" });
    if (!r.ok) return null;
    const html = await r.text();
    const views = ttNum(html, "playCount");
    if (views == null) return null;
    return { views, likes: ttNum(html, "diggCount") ?? 0, comments: ttNum(html, "commentCount") ?? 0, shares: ttNum(html, "shareCount") ?? 0 };
  } catch { return null; }
}

/** Profilzahlen mit 5-Minuten-Cache in kv (tt:<handle>), damit /dashboard live bleibt, ohne TikTok bei jedem Aufruf zu treffen. */
export async function tiktokProfileCached(env: Env, handle: string, maxAgeMs = 5 * 60000) {
  const key = `tt:${handle.replace(/^@/, "")}`;
  const row = await db.first<{ value: string; updated_at: string }>(env, "SELECT value, updated_at FROM kv WHERE key = ?", key);
  if (row?.value && Date.now() - new Date(row.updated_at).getTime() < maxAgeMs) { try { return JSON.parse(row.value); } catch {} }
  const fresh = await tiktokProfile(handle);
  if (fresh) await db.run(env, "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, JSON.stringify(fresh), nowIso());
  else if (row?.value) { try { return JSON.parse(row.value); } catch {} }
  return fresh;
}
