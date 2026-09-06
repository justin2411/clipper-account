// Publisher (Slot-Planer): füllt die freien Slots je Account (heute + morgen) nach Priorität
//   paid > fan-neu (Video < 7 Tage) > backlog (nach Aufrufen)
// Regeln: MAX_CLIPS_PER_DAY Posts je Account/Tag (neue Accounts: RAMP_MAX_PER_DAY in den ersten RAMP_DAYS Tagen,
// explizite account_state-Regeln gehen vor), POST_GAP_MIN Kollisionsschutz über ALLE Accounts und Quellen,
// nie zwei Clips desselben Videos am selben Tag (über beide Accounts), aktive paid-Kampagnen ersetzen
// PAID_SLOTS_PER_DAY Fan-Slots (mehrere: PAID_SLOTS_PER_DAY_MULTI); nach Kampagnenende fällt alles an Fan zurück.
// Modi (PUBLISH_MODE): live → Blotato-Schedule; shadow → nur Datenbank (posts.status='shadow'), nichts geht raus;
// draft → sofort als TikTok-Entwurf (Sichtprüfung). Konzept angelehnt an clippyme SmartScheduler.
import { BLOTATO, Env, PublishMode, blotatoHeaders, db, logEvent, publishMode, toCampaign } from "./shared";

interface AccountCfg { slots: string[]; blotato: Record<string, string>; handle?: string }
export const accountsOf = (env: Env): Record<string, AccountCfg> => {
  try { return JSON.parse(env.ACCOUNTS_JSON || "{}"); } catch { return {}; }
};

export function buildTarget(platform: string, caption: string, draft: boolean, tiktok: Record<string, unknown>) {
  const target: Record<string, unknown> = { targetType: platform };
  if (platform === "tiktok") Object.assign(target, {
    privacyLevel: "PUBLIC_TO_EVERYONE", disabledComments: false, disabledDuet: true, disabledStitch: true,
    isBrandedContent: true, isYourBrand: false, isAiGenerated: false, ...tiktok, isDraft: draft,
  });
  if (platform === "youtube") Object.assign(target, { title: caption.split("\n")[0].slice(0, 95), privacyStatus: "public" });
  if (platform === "instagram") Object.assign(target, { mediaType: "reel" });
  return target;
}

async function blotatoPost(env: Env, accountId: string, platform: string, mediaUrl: string, caption: string, when: string | null, target: Record<string, unknown>) {
  const r = await fetch(`${BLOTATO}/posts`, {
    method: "POST", headers: blotatoHeaders(env),
    body: JSON.stringify({ post: { accountId, content: { text: caption, mediaUrls: [mediaUrl], platform }, target }, ...(when ? { scheduledTime: when } : {}) }),
  });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) console.log("[publisher] blotato", r.status, JSON.stringify(body).slice(0, 300));
  return { ok: r.ok, status: r.status, id: body?.postSubmissionId as string | undefined, error: body?.message ?? body?.error };
}

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const OCCUPYING = "('scheduled','posted','shadow')";       // Post-Status, die einen Slot belegen

/** Wirksame Regeln eines Accounts: explizite account_state-Regel (bis rules_until) > Einlaufphase neuer Accounts
 *  (erste RAMP_DAYS Tage ab erstem Live-Post: RAMP_MAX_PER_DAY) > globales MAX_CLIPS_PER_DAY. */
export async function accountRules(env: Env, account: string, now = new Date()) {
  const st = await db.first<any>(env, "SELECT * FROM account_state WHERE account = ?", account);
  const globalMax = Number(env.MAX_CLIPS_PER_DAY || 5);
  const rampDays = Number(env.RAMP_DAYS || 7), rampMax = Number(env.RAMP_MAX_PER_DAY || 3);
  const explicit = !!(st?.rules_until && new Date(st.rules_until).getTime() > now.getTime());
  const first = await db.first<{ t: string | null }>(env,
    "SELECT MIN(p.posted_at) AS t FROM posts p JOIN clips c ON c.id = p.clip_id WHERE c.account = ? AND p.status = 'posted' AND p.mode = 'live'", account);
  const ageDays = first?.t ? (now.getTime() - new Date(first.t).getTime()) / 86400000 : 0;
  const ramp = ageDays < rampDays;
  const maxPerDay = explicit && st.max_per_day ? Number(st.max_per_day) : ramp ? Math.min(globalMax, rampMax) : globalMax;
  return { maxPerDay, minGapMin: explicit && st.min_gap_min ? Number(st.min_gap_min) : 0, rulesUntil: explicit ? st.rules_until : null,
           ramp, rampUntil: ramp ? new Date((first?.t ? new Date(first.t).getTime() : now.getTime()) + rampDays * 86400000).toISOString() : null };
}

interface Occ { t: number; account: string; video_id: string | null; kind: string | null; day: string }
async function occupied(env: Env, now: Date): Promise<Occ[]> {
  const rows = await db.all<any>(env,
    `SELECT p.scheduled_at, c.account, c.video_id, COALESCE(p.kind, ca.kind) AS kind
     FROM posts p JOIN clips c ON c.id = p.clip_id LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE p.status IN ${OCCUPYING} AND p.scheduled_at >= ? AND p.scheduled_at <= ?`,
    new Date(now.getTime() - 2 * 86400000).toISOString(), new Date(now.getTime() + 3 * 86400000).toISOString());
  return rows.map((r) => ({ t: new Date(r.scheduled_at).getTime(), account: r.account, video_id: r.video_id ?? null, kind: r.kind ?? null, day: day(r.scheduled_at) }));
}

/** n Elemente gleichmäßig verteilt aus einer sortierten Liste. */
const spread = <T>(xs: T[], n: number): T[] => {
  if (n >= xs.length) return xs;
  if (n <= 0) return [];
  if (n === 1) return [xs[0]];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (n - 1))]);
  return [...new Set(out)];
};

/** Freie Slot-Zeitpunkte (ISO) eines Accounts für heute + morgen: Zukunft (>5 min), Tageslimit, Kollisionsschutz
 *  POST_GAP_MIN über alle Accounts (plus eigener Mindestabstand), bei kleinerem Limit gleichmäßig über den Tag verteilt. */
export function planSlots(account: string, slots: string[], maxPerDay: number, occ: Occ[], gapMin: number, ownGapMin: number, now = new Date()): string[] {
  const out: string[] = [];
  const gap = gapMin * 60000, ownGap = Math.max(gapMin, ownGapMin) * 60000;
  const taken = [...occ];
  for (const offset of [0, 1]) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() + offset);
    const date = day(d);
    const used = taken.filter((o) => o.account === account && o.day === date).length;
    const budget = Math.max(0, maxPerDay - used);
    if (!budget) continue;
    const cands: number[] = [];
    for (const s of [...slots].sort()) {
      const t = new Date(`${date}T${s}:00Z`).getTime();
      if (t < now.getTime() + 5 * 60000) continue;
      if (taken.some((o) => Math.abs(o.t - t) < (o.account === account ? ownGap : gap))) continue;
      cands.push(t);
    }
    // gleichmäßig verteilen, aber Mindestabstand auch unter den neu gewählten wahren
    const chosen: number[] = [];
    for (const t of spread(cands, budget)) {
      if (chosen.some((c) => Math.abs(c - t) < ownGap)) continue;
      chosen.push(t);
    }
    for (const t of chosen) { out.push(new Date(t).toISOString()); taken.push({ t, account, video_id: null, kind: null, day: date }); }
  }
  return out;
}

interface Ctx { paidActive: number; paidPerDay: number; occ: Occ[]; usedClips: Set<string>; fillEmpty: boolean }

/** Nächsten Clip für einen Slot wählen: paid-Quote des Tages zuerst, dann Fan (neu vor Backlog), nie zweimal dasselbe Video am Tag. */
async function pickClip(env: Env, account: string, slotIso: string, ctx: Ctx) {
  const d = day(slotIso);
  const videoUsed = new Set(ctx.occ.filter((o) => o.day === d && o.video_id).map((o) => o.video_id as string));
  const paidToday = ctx.occ.filter((o) => o.day === d && o.account === account && o.kind === "paid").length;
  const paidQuota = ctx.paidActive ? Math.max(0, ctx.paidPerDay - paidToday) : 0;
  const ok = (c: any) => !ctx.usedClips.has(c.id) && !(c.video_id && videoUsed.has(c.video_id));
  const paid = async () => (await db.all<any>(env,
    `SELECT c.*, ca.kind, ca.name AS campaign_name FROM clips c JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.status = 'ready' AND c.account = ? AND ca.kind = 'paid' AND ca.status = 'active' ORDER BY c.created_at ASC LIMIT 50`, account)).find(ok);
  const fan = async () => (await db.all<any>(env,
    `SELECT c.*, ca.kind, ca.name AS campaign_name, v.published_at, v.views, v.source
     FROM clips c JOIN campaigns ca ON ca.id = c.campaign_id LEFT JOIN videos v ON v.id = c.video_id
     WHERE c.status = 'ready' AND c.account = ? AND ca.kind = 'fan' AND ca.status = 'active'
     ORDER BY CASE WHEN v.published_at >= ? THEN 0 ELSE 1 END, COALESCE(v.views, 0) DESC, c.rank ASC, c.created_at ASC LIMIT 100`,
    account, new Date(Date.now() - 7 * 86400000).toISOString())).find(ok);
  let c = paidQuota > 0 ? await paid() : null;
  if (!c) c = await fan();
  if (!c && ctx.fillEmpty && paidQuota <= 0) c = await paid();      // Fan-Queue leer → paid darf den Slot füllen
  return c ?? null;
}

async function record(env: Env, mode: PublishMode, c: any, platform: string, submissionId: string | null, when: string, error: string | null) {
  const status = error ? "error" : mode === "shadow" ? "shadow" : mode === "draft" ? "draft" : "scheduled";
  await db.run(env,
    "INSERT INTO posts (clip_id, platform, blotato_submission_id, scheduled_at, status, rejection_reason, kind, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    c.id, platform, submissionId, when, status, error, c.kind ?? "paid", mode);
  return status;
}

export async function runPublisher(env: Env) {
  const mode = publishMode(env);
  const now = new Date();
  const accounts = accountsOf(env);
  const stats = { mode, scheduled: 0, shadow: 0, errors: 0, skipped: [] as string[], plan: [] as string[] };
  if (mode !== "shadow" && !env.BLOTATO_API_KEY) { stats.skipped.push("BLOTATO_API_KEY fehlt"); return stats; }
  await db.run(env, "UPDATE account_state SET paused = 0, reason = NULL, paused_until = NULL WHERE paused = 1 AND paused_until IS NOT NULL AND paused_until <= ?", now.toISOString());
  const paused = new Set((await db.all<{ account: string }>(env, "SELECT account FROM account_state WHERE paused = 1")).map((x) => x.account));
  const paidActive = (await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM campaigns WHERE kind = 'paid' AND status = 'active'"))?.n ?? 0;
  const paidPerDay = paidActive >= 2 ? Number(env.PAID_SLOTS_PER_DAY_MULTI || 3) : Number(env.PAID_SLOTS_PER_DAY || 2);
  const ctx: Ctx = { paidActive, paidPerDay, occ: await occupied(env, now), usedClips: new Set(), fillEmpty: true };
  const GAP = Number(env.POST_GAP_MIN || 90);

  for (const [acc, cfg] of Object.entries(accounts)) {
    if (paused.has(acc)) { stats.skipped.push(`${acc}: pausiert`); continue; }
    const rules = await accountRules(env, acc, now);
    const free = planSlots(acc, cfg.slots ?? [], rules.maxPerDay, ctx.occ, GAP, rules.minGapMin, now);
    for (const slot of free) {
      const c = await pickClip(env, acc, slot, ctx);
      if (!c) { stats.skipped.push(`${acc} ${slot.slice(5, 16)}: kein Clip`); continue; }
      const camp = toCampaign((await db.first(env, "SELECT * FROM campaigns WHERE id = ?", c.campaign_id))!);
      let anyOk = false, k = 0;
      for (const platform of camp.platforms.length ? camp.platforms : ["tiktok"]) {
        const when = new Date(new Date(slot).getTime() + k++ * Number(env.PLATFORM_GAP_MIN || 30) * 60000).toISOString();
        if (mode === "shadow") { await record(env, mode, c, platform, null, when, null); anyOk = true; stats.shadow++; continue; }
        const accountId = cfg.blotato?.[platform];
        if (!accountId) { stats.skipped.push(`${acc}/${platform}: keine Blotato-Account-ID`); continue; }
        const target = buildTarget(platform, c.caption ?? "", mode === "draft", camp.required?.tiktok ?? {});
        const res = await blotatoPost(env, accountId, platform, c.media_url, c.caption ?? "", mode === "draft" ? null : when, target);
        await record(env, mode, c, platform, res.id ?? null, when, res.id ? null : String(res.error ?? res.status));
        if (res.id) { anyOk = true; stats.scheduled++; } else stats.errors++;
      }
      if (anyOk) {
        await db.run(env, "UPDATE clips SET status = ? WHERE id = ?", mode === "shadow" ? "shadow" : mode === "draft" ? "drafted" : "scheduled", c.id);
        ctx.usedClips.add(c.id);
        ctx.occ.push({ t: new Date(slot).getTime(), account: acc, video_id: c.video_id ?? null, kind: c.kind ?? "paid", day: day(slot) });
        stats.plan.push(`${acc} ${slot.slice(5, 16)} ${c.kind} ${String(c.campaign_name ?? c.campaign_id).slice(0, 40)}`);
      } else {
        const fails = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM posts WHERE clip_id = ? AND status = 'error'", c.id);
        if ((fails?.n ?? 0) >= 3) await db.run(env, "UPDATE clips SET status = 'rejected_platform', note = 'blotato: 3x fehlgeschlagen' WHERE id = ?", c.id);
      }
    }
  }
  if (stats.scheduled || stats.shadow) await logEvent(env, `publisher mode=${mode} scheduled=${stats.scheduled} shadow=${stats.shadow} paid_active=${paidActive}`);
  return stats;
}

/** Einen 'ready'-Clip posten – sofort oder zu `when` (ISO). Im Schattenmodus nur Datenbank. */
export async function publishClipNow(env: Env, clipId: string, when: string | null = null) {
  const mode = publishMode(env);
  const c = await db.first<any>(env, "SELECT c.*, ca.kind FROM clips c LEFT JOIN campaigns ca ON ca.id = c.campaign_id WHERE c.id = ?", clipId);
  if (!c) return { error: "clip not found" };
  if (c.status !== "ready") return { error: `clip status is ${c.status}, not ready` };
  const campRow = await db.first(env, "SELECT * FROM campaigns WHERE id = ?", c.campaign_id);
  if (!campRow) return { error: "campaign not found" };
  const camp = toCampaign(campRow);
  const cfg = accountsOf(env)[c.account];
  if (!cfg) return { error: `account ${c.account} not in ACCOUNTS_JSON` };
  const results: unknown[] = [];
  let anyOk = false;
  for (const platform of camp.platforms.length ? camp.platforms : ["tiktok"]) {
    const at = when ?? new Date().toISOString();
    if (mode === "shadow") { await record(env, mode, c, platform, null, at, null); anyOk = true; results.push({ platform, shadow: true }); continue; }
    const accountId = cfg.blotato?.[platform];
    if (!accountId) { results.push({ platform, error: "no Blotato account id" }); continue; }
    const target = buildTarget(platform, c.caption ?? "", mode === "draft", camp.required?.tiktok ?? {});
    const res = await blotatoPost(env, accountId, platform, c.media_url, c.caption ?? "", mode === "draft" ? null : when, target);
    await record(env, mode, c, platform, res.id ?? null, at, res.id ? null : String(res.error ?? res.status));
    if (res.id) anyOk = true;
    results.push({ platform, accountId, submission: res.id ?? null, error: res.error ?? null });
  }
  if (anyOk) await db.run(env, "UPDATE clips SET status = ? WHERE id = ?", mode === "shadow" ? "shadow" : mode === "draft" ? "drafted" : "scheduled", c.id);
  await logEvent(env, `publish_now clip=${c.id} account=${c.account} at=${when ?? "now"} mode=${mode}`, c.campaign_id);
  return { clip: c.id, account: c.account, at: when ?? "now", mode, results };
}

/** Alle 'ready'-Clips einer Kampagne zeitversetzt posten (erster je Account sofort, weitere alle gapMin Minuten), Tageslimit gilt. */
export async function publishCampaignSpaced(env: Env, campaignId: string, gapMin = 45) {
  const today = day(new Date());
  const maxOf: Record<string, number> = {};
  const clips = await db.all<any>(env, "SELECT id, account, seq FROM clips WHERE campaign_id = ? AND status = 'ready' ORDER BY account, seq, created_at", campaignId);
  const perAccount: Record<string, number> = {};
  const budget: Record<string, number> = {};
  const out: unknown[] = [];
  const skipped: string[] = [];
  for (const c of clips) {
    if (budget[c.account] == null) {
      const r = await accountRules(env, c.account); maxOf[c.account] = r.maxPerDay; if (r.minGapMin > gapMin) gapMin = r.minGapMin;
      const used = await db.first<{ n: number }>(env,
        `SELECT COUNT(*) AS n FROM posts p JOIN clips x ON x.id = p.clip_id WHERE x.account = ? AND p.status IN ${OCCUPYING} AND substr(p.scheduled_at,1,10) = ?`, c.account, today);
      budget[c.account] = Math.max(0, r.maxPerDay - (used?.n ?? 0));
    }
    if (budget[c.account] <= 0) { skipped.push(`${c.account}#${c.seq}: Tageslimit ${maxOf[c.account]} erreicht → Slot-Plan`); continue; }
    budget[c.account]--;
    const k = perAccount[c.account] ?? 0;
    const when = k === 0 ? null : new Date(Date.now() + k * gapMin * 60000).toISOString();
    out.push(await publishClipNow(env, c.id, when));
    perAccount[c.account] = k + 1;
  }
  return { campaign: campaignId, gap_min: gapMin, max_per_day: maxOf, posted: out, skipped };
}

/** Geplante Posts (live/shadow) der nächsten `hours` Stunden – für Tagesübersicht und CLI. */
export async function plannedPosts(env: Env, hours = 24, from = new Date()) {
  return db.all<any>(env,
    `SELECT p.id, p.scheduled_at, p.status, p.mode, COALESCE(p.kind, ca.kind) AS kind, c.account, c.caption, c.hook, c.video_id, c.thumb_url,
            c.campaign_id, ca.name AS campaign_name
     FROM posts p JOIN clips c ON c.id = p.clip_id LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE p.status IN ${OCCUPYING} AND p.scheduled_at >= ? AND p.scheduled_at < ? ORDER BY p.scheduled_at`,
    from.toISOString(), new Date(from.getTime() + hours * 3600000).toISOString());
}

/** Schattenmodus beenden: Schatten-Posts archivieren, ihre Clips wieder auf 'ready' (werden live neu geplant). */
export async function releaseShadow(env: Env) {
  const clips = await db.run(env, "UPDATE clips SET status = 'ready' WHERE status = 'shadow'");
  const posts = await db.run(env, "UPDATE posts SET status = 'shadow_done' WHERE status = 'shadow'");
  await logEvent(env, `shadow_release clips=${clips.meta.changes} posts=${posts.meta.changes}`);
  return { clips: clips.meta.changes, posts: posts.meta.changes };
}
