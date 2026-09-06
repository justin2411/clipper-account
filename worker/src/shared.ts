// Gemeinsame Helfer: Env-Typen, D1-Zugriff, Telegram, Blotato, JSON-Antworten.

export interface Env {
  DB: D1Database;
  CLIPS: R2Bucket;
  // vars (wrangler.toml)
  BLOTATO_DRAFT?: string;            // veraltet – PUBLISH_MODE=draft
  PUBLISH_MODE?: string;             // live | shadow | draft
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
export const publishMode = (env: Env): PublishMode => {
  const m = (env.PUBLISH_MODE ?? "").toLowerCase();
  if (m === "live" || m === "shadow" || m === "draft") return m;
  return (env.BLOTATO_DRAFT ?? "true") === "true" ? "draft" : "live";
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
