// Notify (täglich 20:00 Berlin): Einreich-Liste (paid), Tagesübersicht (immer im Schattenmodus, sonst kompakt),
// montags Wochenreport getrennt nach paid/fan. Telegram informiert nur – keine Freigabe nötig.
import { Env, db, publishMode, telegram, telegramPhoto } from "./shared";
import { accountsOf, accountRules, plannedPosts } from "./publisher";
import { fanStock } from "./fan";

const berlin = (iso: string) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const berlinDay = (iso: string) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit" }).format(new Date(iso));

async function submissionList(env: Env) {
  const rows = await db.all<any>(env,
    `SELECT p.post_url, c.campaign_id, ca.name, ca.external_url, ca.platform
     FROM posts p JOIN clips c ON c.id = p.clip_id JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE p.status = 'posted' AND p.submitted_at IS NULL AND p.post_url IS NOT NULL AND p.post_url != '' AND ca.kind = 'paid'`);
  const byCamp: Record<string, { name: string; url: string; platform: string; links: string[] }> = {};
  for (const r of rows) (byCamp[r.campaign_id] ??= { name: r.name, url: r.external_url ?? "", platform: r.platform, links: [] }).links.push(r.post_url);
  for (const [id, c] of Object.entries(byCamp)) {
    await telegram(env, `📎 ${c.platform.toUpperCase()} – ${c.name}: ${c.links.length} Posts einreichen\n${c.url}\n\n${c.links.join("\n")}\n\nApp → Kampagne → Add post → URLs einfügen. Danach: python scripts/mark_submitted.py ${id}`);
  }
  return { campaigns: Object.keys(byCamp).length, posts: rows.length };
}

/** Tagesübersicht: Slots der nächsten 24 h, Queue, neue Videos, Fehler; dazu 3 zufällige Clips als Standbild + Caption. */
export async function dailyOverview(env: Env, withPhotos = true) {
  const mp = publishMode(env, "paid"), mf = publishMode(env, "fan");
  const label = (m: string) => (m === "shadow" ? "Schatten" : m === "draft" ? "Entwurf" : "LIVE");
  const now = new Date();
  const plan = await plannedPosts(env, 24, now);
  const accounts = accountsOf(env);
  const stock = await fanStock(env);
  const lines: string[] = [`🗓 ClipForge Tagesübersicht (paid: ${label(mp)} · Fan: ${label(mf)}${mf === "shadow" ? " – Fan-Clips gehen nicht raus" : ""})`, ""];
  lines.push(`Geplante Slots, nächste 24 h (${plan.length}):`);
  if (!plan.length) lines.push("  – keine");
  for (const p of plan) {
    const what = p.kind === "paid" ? `💰 ${p.campaign_name}` : `⭐ ${String(p.campaign_name ?? "").replace(/^[^:]+: /, "")}`;
    lines.push(`  ${berlinDay(p.scheduled_at)} ${berlin(p.scheduled_at)} · ${p.account} · ${what}\n     „${String(p.caption ?? p.hook ?? "").split("\n")[0].slice(0, 80)}“`);
  }
  lines.push("", "Queue:");
  for (const acc of Object.keys(accounts)) {
    const r = await accountRules(env, acc, now);
    const q = await db.first<any>(env,
      `SELECT SUM(CASE WHEN ca.kind='paid' AND c.status='ready' THEN 1 ELSE 0 END) AS paid_ready,
              SUM(CASE WHEN ca.kind='fan' AND c.status='ready' THEN 1 ELSE 0 END) AS fan_ready,
              SUM(CASE WHEN c.status='shadow' THEN 1 ELSE 0 END) AS shadow,
              SUM(CASE WHEN c.status='scheduled' THEN 1 ELSE 0 END) AS scheduled
       FROM clips c JOIN campaigns ca ON ca.id = c.campaign_id WHERE c.account = ?`, acc);
    const st = await db.first<any>(env, "SELECT paused, reason, paused_until FROM account_state WHERE account = ?", acc);
    lines.push(`  ${acc} ${accounts[acc].handle ?? ""}: ${q?.fan_ready ?? 0} Fan + ${q?.paid_ready ?? 0} paid bereit · ${q?.shadow ?? 0} im Schatten geplant · ${q?.scheduled ?? 0} live geplant · Soll-Vorrat ${stock[acc]?.target ?? "?"} (${r.maxPerDay}/Tag${r.ramp ? ", Einlaufphase" : ""})${st?.paused ? ` · ⏸ pausiert${st.paused_until ? " bis " + berlinDay(st.paused_until) + " " + berlin(st.paused_until) : ""}` : ""}`);
  }
  const since = new Date(now.getTime() - 86400000).toISOString();
  const vids = await db.all<any>(env, "SELECT channel_name, title, status, source FROM videos WHERE created_at >= ? ORDER BY created_at DESC LIMIT 10", since);
  const vc = await db.first<any>(env, "SELECT SUM(status='new') AS n_new, SUM(status='queued') AS n_q, SUM(status='clipped') AS n_c, SUM(status='error') AS n_e FROM videos");
  lines.push("", `Videos: ${vids.filter((v) => v.source === "rss").length} neu erschienen (24 h) · Backlog: ${vc?.n_new ?? 0} offen, ${vc?.n_q ?? 0} in Arbeit, ${vc?.n_c ?? 0} geclippt, ${vc?.n_e ?? 0} Fehler`);
  for (const v of vids.filter((v) => v.source === "rss")) lines.push(`  🎬 ${v.channel_name}: ${v.title} (${v.status})`);
  const errs = await db.all<any>(env,
    "SELECT at, event FROM events WHERE at >= ? AND (event LIKE '%error%' OR event LIKE '%failed%' OR event LIKE 'footage_missing%' OR event LIKE 'clipper_error%') ORDER BY id DESC LIMIT 8", since);
  lines.push("", `Fehler (24 h): ${errs.length ? "" : "keine"}`);
  for (const e of errs) lines.push(`  ${berlin(e.at)} ${e.event.slice(0, 90)}`);
  const text = lines.join("\n");
  await telegram(env, text.slice(0, 4000));
  let photos = 0;
  if (withPhotos) {
    const picks = await db.all<any>(env,
      `SELECT c.caption, c.account, c.thumb_url, ca.kind, ca.name FROM clips c JOIN campaigns ca ON ca.id = c.campaign_id
       WHERE c.status IN ('ready','shadow') AND c.thumb_url IS NOT NULL ORDER BY RANDOM() LIMIT 3`);
    for (const p of picks) if (await telegramPhoto(env, p.thumb_url, `${p.kind === "paid" ? "💰" : "⭐"} ${p.account} · ${p.name}\n\n${p.caption ?? ""}`)) photos++;
  }
  return { planned: plan.length, photos, errors: errs.length };
}

/** Wochenreport (montags): Posts, Views (falls vorhanden) und Accounts getrennt nach paid/fan. */
export async function weeklyReport(env: Env) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = await db.all<any>(env,
    `SELECT COALESCE(p.kind, ca.kind) AS kind, c.account, COUNT(*) AS posts,
            SUM(CASE WHEN p.status='posted' THEN 1 ELSE 0 END) AS live, SUM(CASE WHEN p.status='shadow' THEN 1 ELSE 0 END) AS shadow,
            AVG(COALESCE(p.views_7d, p.views_72h, p.views_24h)) AS views, SUM(CASE WHEN p.status='rejected_platform' THEN 1 ELSE 0 END) AS rejected
     FROM posts p JOIN clips c ON c.id = p.clip_id LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE p.scheduled_at >= ? GROUP BY 1, 2 ORDER BY 1, 2`, since);
  const clips = await db.all<any>(env,
    `SELECT ca.kind, COUNT(*) AS n, SUM(CASE WHEN c.status LIKE 'rejected%' THEN 1 ELSE 0 END) AS rejected
     FROM clips c JOIN campaigns ca ON ca.id = c.campaign_id WHERE c.created_at >= ? GROUP BY 1`, since);
  const sub = await db.first<any>(env, "SELECT COUNT(*) AS n FROM posts WHERE submitted_at >= ?", since);
  const pay = await db.first<any>(env, "SELECT COALESCE(SUM(amount_usd),0) AS s FROM payouts WHERE at >= ?", since);
  const L = [`📊 Wochenreport (7 Tage)`, ""];
  for (const kind of ["paid", "fan"]) {
    const k = rows.filter((r) => r.kind === kind), cl = clips.find((c) => c.kind === kind);
    L.push(`${kind === "paid" ? "💰 Paid" : "⭐ Fan"}: ${cl?.n ?? 0} Clips produziert (${cl?.rejected ?? 0} verworfen)`);
    for (const r of k) L.push(`  ${r.account}: ${r.posts} Posts (${r.live} live, ${r.shadow} Schatten, ${r.rejected} abgelehnt)${r.views ? ` · Ø ${Math.round(r.views)} Views` : ""}`);
    if (!k.length) L.push("  – keine Posts");
  }
  L.push("", `Vyro eingereicht: ${sub?.n ?? 0} · Auszahlungen: ${Math.round(pay?.s ?? 0)} $`);
  await telegram(env, L.join("\n"));
  return { rows: rows.length };
}

export async function runNotify(env: Env) {
  const out: Record<string, unknown> = {};
  const { runAnomalyCheck } = await import("./insights");
  out.anomalies = await runAnomalyCheck(env).catch((e: any) => ({ error: String(e?.message ?? e) }));   // Nachtrag 7: täglicher Anomalie-Check (eigener Cron nicht möglich, Free-Limit 5)
  const { rateVideos } = await import("./catalog");
  out.catalog = await rateVideos(env, 60).catch((e: any) => ({ error: String(e?.message ?? e) }));    // Nachschub-Agent: Katalog nachbewerten (Tagesbudget gilt)
  const { runPacer } = await import("./pacer");
  out.pacer = await runPacer(env).catch((e: any) => ({ error: String(e?.message ?? e) }));            // Taktgeber im Beobachtungsmodus: schlägt vor, ändert nichts
  out.submissions = await submissionList(env);
  out.overview = await dailyOverview(env, publishMode(env, "fan") === "shadow" || publishMode(env, "paid") === "shadow");
  return out;
}
