// HTTP-API des Workers.
//   GET  /media/<key>                 öffentlich: Clip aus R2 (für Blotato/TikTok)
//   GET  /dashboard                   Dashboard-JSON, Header x-api-key = DASHBOARD_READ_KEY (nur lesen; CORS für Pages)
//   alles unter /api/* braucht  Authorization: Bearer <CLIPFORGE_API_KEY>
//   GET  /api/health | /api/overview
//   GET  /api/campaigns[/:id] | POST /api/campaigns (upsert) | PATCH /api/campaigns/:id | POST /api/campaigns/:id/submitted
//   GET  /api/clips?status=&account=&campaign= | POST /api/clips
//   POST /api/events
//   PUT  /api/media/<key>             Upload nach R2 → {url}
//   POST /api/run/:fn                 scout | publisher | tracker | notify manuell starten
//   POST /api/dispatch/:campaign/:account   Clip-Job (GitHub Actions) gezielt für einen Account starten
//   GET  /api/blotato/accounts        verbundene Blotato-Accounts (IDs für config/accounts.yaml)
//   POST /api/telegram/send           {text}  Info-Nachricht (Pipeline meldet z.B. "Clip-Job fertig")
//   Für scripts/vyro_submit.py (Header x-api-key = CLIPFORGE_API_KEY):
//   GET  /submissions/pending         offene Posts [{post_id, campaign_id, campaign_url, post_url, account, account_handle}]
//   POST /submissions/mark            {post_id, status: submitted|failed, note}
//   POST /notify                      {text} → Telegram
import { Env, Row, db, json, logEvent, mediaUrl, nowIso, toCampaign } from "./shared";
import { runScout, dispatchClipJob } from "./scout";
import { runPublisher, publishClipNow, publishCampaignSpaced } from "./publisher";
import { runTracker } from "./tracker";
import { runNotify } from "./notify";
import { buildDashboard } from "./dashboard";
import { BLOTATO, blotatoHeaders, telegram } from "./shared";

export const FUNCTIONS: Record<string, (env: Env) => Promise<unknown>> = {
  scout: runScout, publisher: runPublisher, tracker: runTracker, notify: runNotify,
};

const CAMPAIGN_FIELDS = ["platform", "name", "external_url", "status", "rate_per_1k_usd", "min_views", "max_per_post_usd", "min_seconds", "footage", "required", "forbidden", "accounts", "platforms", "budget_total_usd", "budget_used_usd"];
const JSON_FIELDS = new Set(["footage", "required", "forbidden", "accounts", "platforms"]);
const enc = (k: string, v: unknown) => (JSON_FIELDS.has(k) ? JSON.stringify(v ?? (k === "accounts" || k === "platforms" ? [] : {})) : v ?? null);

function authorized(req: Request, env: Env): boolean {
  const key = env.CLIPFORGE_API_KEY;
  if (!key) return false;
  const given = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "") || req.headers.get("x-api-key") || "";
  if (given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function serveMedia(req: Request, env: Env, key: string): Promise<Response> {
  const range = req.headers.get("Range");
  let obj: R2Object | R2ObjectBody | null;
  let opts: R2GetOptions = {};
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m) {
    if (m[1] && m[2]) opts = { range: { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } };
    else if (m[1]) opts = { range: { offset: Number(m[1]) } };
    else if (m[2]) opts = { range: { suffix: Number(m[2]) } };
  }
  obj = req.method === "HEAD" ? await env.CLIPS.head(key) : await env.CLIPS.get(key, opts);
  if (!obj) return new Response("not found", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("Content-Type", obj.httpMetadata?.contentType ?? "video/mp4");
  h.set("Accept-Ranges", "bytes");
  h.set("ETag", obj.httpEtag);
  h.set("Cache-Control", "public, max-age=3600");
  if (req.method === "HEAD") { h.set("Content-Length", String(obj.size)); return new Response(null, { headers: h }); }
  const body = obj as R2ObjectBody;
  if (m && body.range && "offset" in body.range) {
    const off = body.range.offset ?? 0, len = body.range.length ?? obj.size - off;
    h.set("Content-Range", `bytes ${off}-${off + len - 1}/${obj.size}`);
    h.set("Content-Length", String(len));
    return new Response(body.body, { status: 206, headers: h });
  }
  h.set("Content-Length", String(obj.size));
  return new Response(body.body, { headers: h });
}

export async function handleRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const seg = path.split("/").filter(Boolean);

  if (seg[0] === "media" && seg.length >= 2 && (req.method === "GET" || req.method === "HEAD"))
    return serveMedia(req, env, seg.slice(1).map(decodeURIComponent).join("/"));
  if (path === "/") return json({ service: "clipforge", ok: true });

  // Einreich-Schnittstelle für scripts/vyro_submit.py
  if (path === "/submissions/pending" || path === "/submissions/mark" || path === "/notify") {
    if (!env.CLIPFORGE_API_KEY) return json({ error: "CLIPFORGE_API_KEY nicht gesetzt" }, 503);
    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
    const accounts = (() => { try { return JSON.parse(env.ACCOUNTS_JSON || "{}"); } catch { return {}; } })() as Record<string, any>;
    if (path === "/submissions/pending" && req.method === "GET") {
      const rows = await db.all<any>(env,
        `SELECT p.id AS post_id, c.campaign_id, ca.external_url AS campaign_url, p.post_url, c.account, p.submit_attempts
         FROM posts p JOIN clips c ON c.id = p.clip_id JOIN campaigns ca ON ca.id = c.campaign_id
         WHERE p.status = 'posted' AND p.post_url IS NOT NULL AND p.post_url != '' AND p.submitted_at IS NULL
           AND ca.platform = 'vyro' AND ca.status IN ('active','joined') AND p.submit_attempts < 3
         ORDER BY p.posted_at ASC`);
      return json(rows.map((r) => ({ ...r, account_handle: accounts[r.account]?.handle ?? "" })));
    }
    if (path === "/submissions/mark" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Row;
      const post = await db.first<any>(env, "SELECT * FROM posts WHERE id = ?", b.post_id);
      if (!post) return json({ error: "post not found" }, 404);
      const note = String(b.note ?? "").slice(0, 300);
      if (b.status === "submitted") {
        await db.run(env, "UPDATE posts SET submitted_at = ?, submit_note = ? WHERE id = ?", nowIso(), note, post.id);
        const open = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM posts WHERE clip_id = ? AND status = 'posted' AND submitted_at IS NULL", post.clip_id);
        if (!open?.n) await db.run(env, "UPDATE clips SET status = 'submitted' WHERE id = ? AND status = 'posted'", post.clip_id);
        await logEvent(env, `vyro_submitted post=${post.id}`, null);
        return json({ ok: true, post_id: post.id, status: "submitted" });
      }
      if (b.status === "failed") {
        await db.run(env, "UPDATE posts SET submit_note = ?, submit_attempts = submit_attempts + 1 WHERE id = ?", note, post.id);
        await logEvent(env, `vyro_submit_failed post=${post.id} ${note.slice(0, 80)}`, null);
        return json({ ok: true, post_id: post.id, status: "failed", attempts: (post.submit_attempts ?? 0) + 1 });
      }
      return json({ error: "status must be submitted|failed" }, 400);
    }
    if (path === "/notify" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Row;
      return json({ sent: await telegram(env, String(b.text ?? "")) });
    }
    return json({ error: "method not allowed" }, 405);
  }
  if (path === "/dashboard") {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "x-api-key, content-type", "Access-Control-Allow-Methods": "GET, OPTIONS" };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const key = env.DASHBOARD_READ_KEY ?? "", given = req.headers.get("x-api-key") ?? "";
    let diff = key.length ^ given.length;
    for (let i = 0; i < key.length && i < given.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
    if (!key || diff !== 0) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...cors } });
    try {
      return new Response(JSON.stringify(await buildDashboard(env)), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 500, headers: { "Content-Type": "application/json", ...cors } });
    }
  }

  if (seg[0] !== "api") return new Response("not found", { status: 404 });

  if (!env.CLIPFORGE_API_KEY) return json({ error: "CLIPFORGE_API_KEY nicht gesetzt (wrangler secret put CLIPFORGE_API_KEY)" }, 503);
  if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
  const rest = seg.slice(1);
  const body = async (): Promise<Row> => (req.headers.get("Content-Type")?.includes("json") ? ((await req.json()) as Row) : {});

  try {
    // health / overview
    if (rest[0] === "health") return json({ ok: true, time: nowIso(), draft: (env.BLOTATO_DRAFT ?? "true") === "true",
      configured: { blotato: !!env.BLOTATO_API_KEY, telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), gmail: !!env.GMAIL_REFRESH_TOKEN, github: !!env.GITHUB_TOKEN, accounts: !!env.ACCOUNTS_JSON } });
    if (rest[0] === "overview") {
      const counts = async (t: string) => db.all(env, `SELECT status, COUNT(*) AS n FROM ${t} GROUP BY status`);
      return json({ campaigns: await counts("campaigns"), clips: await counts("clips"), posts: await counts("posts"),
        accounts: await db.all(env, "SELECT * FROM account_state"), events: await db.all(env, "SELECT * FROM events ORDER BY id DESC LIMIT 20") });
    }

    // campaigns
    if (rest[0] === "campaigns") {
      if (req.method === "GET" && !rest[1]) return json((await db.all(env, "SELECT * FROM campaigns ORDER BY created_at DESC")).map(toCampaign));
      if (req.method === "POST" && !rest[1]) {
        const b = await body();
        if (!b.id || !b.platform || !b.name) return json({ error: "id, platform, name erforderlich" }, 400);
        const keys = ["id", ...CAMPAIGN_FIELDS.filter((k) => k in b)];
        const sets = keys.filter((k) => k !== "id").map((k) => `${k} = excluded.${k}`).join(", ");
        await db.run(env, `INSERT INTO campaigns (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${sets}`,
          ...keys.map((k) => enc(k, b[k])));
        return json(toCampaign((await db.first(env, "SELECT * FROM campaigns WHERE id = ?", b.id))!), 201);
      }
      const id = rest[1];
      if (!id) return json({ error: "not found" }, 404);
      const row = await db.first(env, "SELECT * FROM campaigns WHERE id = ?", id);
      if (!row) return json({ error: `campaign ${id} not found` }, 404);
      if (req.method === "GET" && !rest[2]) return json(toCampaign(row));
      if (req.method === "PATCH" && !rest[2]) {
        const b = await body();
        const keys = CAMPAIGN_FIELDS.filter((k) => k in b);
        if (!keys.length) return json({ error: "keine Felder" }, 400);
        await db.run(env, `UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => enc(k, b[k])), id);
        await logEvent(env, `campaign_patch:${keys.join(",")}`, id);
        return json(toCampaign((await db.first(env, "SELECT * FROM campaigns WHERE id = ?", id))!));
      }
      if (req.method === "POST" && rest[2] === "submitted") {
        // Nur wirklich gepostete Clips (Post-URL vorhanden) gelten als eingereicht; geplante bleiben unberührt,
        // sonst löscht der Tracker ihre Dateien, bevor Blotato sie posten kann.
        const now = nowIso();
        const clips = await db.all<{ id: string }>(env,
          `SELECT DISTINCT c.id FROM clips c JOIN posts p ON p.clip_id = c.id
           WHERE c.campaign_id = ? AND c.status = 'posted' AND p.status = 'posted' AND p.post_url IS NOT NULL AND p.submitted_at IS NULL`, id);
        for (const c of clips) {
          await db.run(env, "UPDATE posts SET submitted_at = ? WHERE clip_id = ? AND status = 'posted' AND submitted_at IS NULL", now, c.id);
          await db.run(env, "UPDATE clips SET status = 'submitted' WHERE id = ?", c.id);
        }
        await logEvent(env, `submitted:${clips.length}`, id);
        return json({ marked: clips.length });
      }
    }

    // clips
    if (rest[0] === "clips" && !rest[1]) {
      if (req.method === "GET") {
        const w: string[] = [], p: unknown[] = [];
        for (const k of ["status", "account", "campaign"]) { const v = url.searchParams.get(k); if (v) { w.push(`${k === "campaign" ? "campaign_id" : k} = ?`); p.push(v); } }
        return json(await db.all(env, `SELECT * FROM clips ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 500`, ...p));
      }
      if (req.method === "POST") {
        const b = await body();
        if (!b.campaign_id || !b.account || !b.media_url) return json({ error: "campaign_id, account, media_url erforderlich" }, 400);
        const id = crypto.randomUUID().replace(/-/g, "");
        // seq = laufende Nummer je Kampagne (atomar im INSERT); Standardstatus 'ready' → Publisher postet zu den Slots
        await db.run(env,
          `INSERT INTO clips (id, campaign_id, account, media_url, caption, hook_type, status, note, seq, duration_s, hook)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ? FROM clips WHERE campaign_id = ?`,
          id, b.campaign_id, b.account, b.media_url, b.caption ?? null, b.hook_type ?? null, b.status ?? "ready", b.note ?? null,
          b.duration_s ?? null, b.hook ?? null, b.campaign_id);
        const row = await db.first<{ seq: number }>(env, "SELECT seq FROM clips WHERE id = ?", id);
        return json({ id, seq: row?.seq ?? null }, 201);
      }
    }

    // events
    if (rest[0] === "events" && req.method === "POST") {
      const b = await body();
      if (!b.event) return json({ error: "event erforderlich" }, 400);
      await logEvent(env, String(b.event), (b.campaign_id as string) ?? null);
      return json({ ok: true }, 201);
    }

    // media upload
    if (rest[0] === "media" && rest.length >= 2 && req.method === "PUT") {
      const key = rest.slice(1).map(decodeURIComponent).join("/");
      if (!req.body) return json({ error: "leerer Body" }, 400);
      await env.CLIPS.put(key, req.body, { httpMetadata: { contentType: req.headers.get("Content-Type") ?? "video/mp4" } });
      return json({ key, url: mediaUrl(url.origin, key) }, 201);
    }
    if (rest[0] === "media" && rest.length >= 2 && req.method === "DELETE") {
      await env.CLIPS.delete(rest.slice(1).map(decodeURIComponent).join("/"));
      return json({ ok: true });
    }

    // manual run
    if (rest[0] === "run" && rest[1] && req.method === "POST") {
      const fn = FUNCTIONS[rest[1]];
      if (!fn) return json({ error: `unbekannt: ${rest[1]}` }, 404);
      return json({ fn: rest[1], result: await fn(env) });
    }

    // einen 'ready'-Clip sofort veröffentlichen (statt auf den nächsten Slot zu warten); ?at=<ISO> für einen festen Zeitpunkt
    if (rest[0] === "publish_now" && rest[1] && req.method === "POST") {
      return json(await publishClipNow(env, rest[1], url.searchParams.get("at")));
    }
    // alle 'ready'-Clips einer Kampagne zeitversetzt (erster je Account sofort, dann alle ?gap=45 Minuten)
    if (rest[0] === "publish_campaign" && rest[1] && req.method === "POST") {
      return json(await publishCampaignSpaced(env, rest[1], Number(url.searchParams.get("gap") || 45)));
    }

    // go live: Entwurfs-Clips wieder freigeben (nach Sichtprüfung, BLOTATO_DRAFT=false deployen)
    if (rest[0] === "go_live" && req.method === "POST") {
      const r = await db.run(env, "UPDATE clips SET status = 'ready' WHERE status = 'drafted'");
      await db.run(env, "UPDATE account_state SET paused = 0, reason = NULL WHERE reason = 'review'");
      await logEvent(env, `go_live: ${r.meta.changes} drafted clips → ready, review-pause aufgehoben`);
      return json({ released: r.meta.changes, draft_mode_now: (env.BLOTATO_DRAFT ?? "true") === "true" });
    }

    // manual clip job dispatch for one account
    if (rest[0] === "dispatch" && rest[1] && rest[2] && req.method === "POST") {
      const camp = await db.first(env, "SELECT id FROM campaigns WHERE id = ?", rest[1]);
      if (!camp) return json({ error: `campaign ${rest[1]} not found` }, 404);
      const status = await dispatchClipJob(env, rest[1], rest[2]);
      if (status === 204) await logEvent(env, `clip_job_dispatched account=${rest[2]} (manual)`, rest[1]);
      return json({ campaign: rest[1], account: rest[2], github_status: status, ok: status === 204 }, status === 204 ? 200 : 502);
    }

    // blotato accounts
    if (rest[0] === "blotato" && rest[1] === "accounts" && req.method === "GET") {
      if (!env.BLOTATO_API_KEY) return json({ error: "BLOTATO_API_KEY nicht gesetzt" }, 503);
      const r = await fetch(`${BLOTATO}/users/me/accounts`, { headers: blotatoHeaders(env) });
      return json(await r.json().catch(() => ({ status: r.status })), r.status);
    }

    // telegram info message
    if (rest[0] === "telegram" && (rest[1] === "send" || rest[1] === "test") && req.method === "POST") {
      const b = await body();
      return json({ sent: await telegram(env, String(b.text ?? "ClipForge: Telegram-Test ✅")) });
    }

    return json({ error: "not found" }, 404);
  } catch (e: any) {
    console.log("[api] error", e?.message ?? e);
    return json({ error: String(e?.message ?? e) }, 500);
  }
}
