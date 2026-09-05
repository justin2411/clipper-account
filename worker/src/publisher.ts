// Publisher: nimmt 'ready'-Clips, verteilt sie auf freie Slots (heute/morgen, max N/Tag/Account) und
// schedult sie bei Blotato, zeitversetzt über die Plattformen. TikTok-Pflichtfelder inkl. isBrandedContent
// aus der Kampagne. BLOTATO_DRAFT=true → Posts landen als TikTok-Entwurf (Einlaufphase, Sichtprüfung).
import { BLOTATO, Env, blotatoHeaders, db, logEvent, toCampaign } from "./shared";

interface AccountCfg { slots: string[]; blotato: Record<string, string> }
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

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Freie Slot-Zeitpunkte (ISO) für einen Account: heute + morgen, nur Zukunft (>5 min), unbelegt, max N/Tag. */
export async function freeSlots(env: Env, account: string, slots: string[], maxPerDay: number, now = new Date()): Promise<string[]> {
  const out: string[] = [];
  for (const offset of [0, 1]) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() + offset);
    const date = day(d);
    const used = await db.all<{ scheduled_at: string }>(env,
      `SELECT p.scheduled_at FROM posts p JOIN clips c ON c.id = p.clip_id
       WHERE c.account = ? AND p.status IN ('scheduled','posted') AND substr(p.scheduled_at,1,10) = ?`, account, date);
    let budget = Math.max(0, maxPerDay - used.length);
    const taken = new Set(used.map((u) => u.scheduled_at.slice(0, 16)));
    for (const s of [...slots].sort()) {
      if (budget <= 0) break;
      const t = new Date(`${date}T${s}:00Z`);
      if (t.getTime() < now.getTime() + 5 * 60000) continue;
      if (taken.has(t.toISOString().slice(0, 16))) continue;
      out.push(t.toISOString()); budget--;
    }
  }
  return out;
}

export async function runPublisher(env: Env) {
  const DRAFT = (env.BLOTATO_DRAFT ?? "true") === "true";
  const MAX = Number(env.MAX_CLIPS_PER_DAY || 5);
  const GAP = Number(env.PLATFORM_GAP_MIN || 30);
  const accounts = accountsOf(env);
  const stats = { draft: DRAFT, scheduled: 0, errors: 0, skipped: [] as string[] };
  if (!env.BLOTATO_API_KEY) { stats.skipped.push("BLOTATO_API_KEY fehlt"); return stats; }
  const paused = new Set((await db.all<{ account: string }>(env, "SELECT account FROM account_state WHERE paused = 1")).map((x) => x.account));

  for (const [acc, cfg] of Object.entries(accounts)) {
    if (paused.has(acc)) { stats.skipped.push(`${acc}: pausiert`); continue; }
    const free = await freeSlots(env, acc, cfg.slots ?? [], MAX);
    if (!free.length) continue;
    const clips = await db.all(env, "SELECT * FROM clips WHERE status = 'ready' AND account = ? ORDER BY created_at ASC LIMIT ?", acc, free.length);
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i] as any, slot = free[i];
      const campRow = await db.first(env, "SELECT * FROM campaigns WHERE id = ?", c.campaign_id);
      if (!campRow) { stats.skipped.push(`${c.id}: Kampagne fehlt`); continue; }
      const camp = toCampaign(campRow);
      if (camp.status === "paused" || camp.status === "ended") { stats.skipped.push(`${c.id}: Kampagne ${camp.status}`); continue; }
      let k = 0, anyOk = false;
      for (const platform of camp.platforms.length ? camp.platforms : ["tiktok"]) {
        const accountId = cfg.blotato?.[platform];
        if (!accountId) { stats.skipped.push(`${acc}/${platform}: keine Blotato-Account-ID`); continue; }
        const when = new Date(new Date(slot).getTime() + k++ * GAP * 60000).toISOString();
        const target = buildTarget(platform, c.caption ?? "", DRAFT, camp.required?.tiktok ?? {});
        // Draft-Modus: sofort als Entwurf anlegen (nicht öffentlich) statt auf den Slot zu warten → schnelle Sichtprüfung
        const res = await blotatoPost(env, accountId, platform, c.media_url, c.caption ?? "", DRAFT ? null : when, target);
        // Draft-Modus: Zeilen als 'draft'/'drafted' führen – zählen nicht als Slot, Tracker/Notify ignorieren sie,
        // beim Umschalten auf Live werden 'drafted'-Clips wieder auf 'ready' gesetzt (scripts/run_fn.py go_live).
        await db.run(env,
          "INSERT INTO posts (clip_id, platform, blotato_submission_id, scheduled_at, status, rejection_reason) VALUES (?, ?, ?, ?, ?, ?)",
          c.id, platform, res.id ?? null, when, res.id ? (DRAFT ? "draft" : "scheduled") : "error", res.id ? null : String(res.error ?? res.status));
        if (res.id) { anyOk = true; stats.scheduled++; } else stats.errors++;
      }
      if (anyOk) await db.run(env, "UPDATE clips SET status = ? WHERE id = ?", DRAFT ? "drafted" : "scheduled", c.id);
      else {
        // Dauerfehler (z.B. Blotato lehnt Medium ab): nach 3 Fehlversuchen nicht mehr retryen
        const fails = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM posts WHERE clip_id = ? AND status = 'error'", c.id);
        if ((fails?.n ?? 0) >= 3) await db.run(env, "UPDATE clips SET status = 'rejected_platform', note = 'blotato: 3x fehlgeschlagen' WHERE id = ?", c.id);
      }
    }
  }
  if (stats.scheduled) await logEvent(env, `publisher scheduled=${stats.scheduled} draft=${DRAFT}`);
  return stats;
}
