// Clip-Vorschau (Studio): Clips ready/scheduled/shadow/review mit Video-URL, Cover, Scores, QA; Aktionen approve/reject/redo/edit.
// approve: nächster freier Slot des Accounts → sofort geplant und automatisch gepostet (Modus des Clip-Typs).
// redo: Clip verworfen, Clip-Job der Kampagne neu mit Feedback als Zusatzanweisung (Few-Shot aus feedback-Tabelle).
import { Env, db, logEvent, nichesOf } from "./shared";
import { accountsOf, accountRules, planSlots, publishClipNow } from "./publisher";
import { dispatchClipJob } from "./scout";

const parse = <T>(v: unknown, fb: T): T => { try { return typeof v === "string" ? (JSON.parse(v) as T) : ((v as T) ?? fb); } catch { return fb; } };

export async function listReview(env: Env, ws = "default") {
  const rows = await db.all<any>(env,
    `SELECT c.*, ca.name AS campaign_name, ca.kind, ca.niche_id, ca.probe_state, (SELECT MIN(p.scheduled_at) FROM posts p WHERE p.clip_id = c.id AND p.status IN ('scheduled','shadow')) AS scheduled_for
     FROM clips c JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.workspace_id = ? AND c.status IN ('ready','review','scheduled','shadow') ORDER BY c.created_at DESC LIMIT 60`, ws);
  const acc = accountsOf(env);
  return rows.map((c) => {
    const sc = parse<Record<string, number>>(c.scores, {});
    const qa = parse<any>(c.qa, null);
    return { id: c.id, account: c.account, niche: c.niche_id ?? acc[c.account]?.niche ?? nichesOf(env)[0]?.key ?? "", source: c.campaign_name, campaign_id: c.campaign_id, status: c.status,
      video_url: c.media_url, cover_url: c.cover_url ?? c.thumb_url ?? "", caption: c.caption ?? "", hook: c.context_line ?? c.hook ?? "", duration: Math.round(c.duration_s ?? 0),
      qa: qa ? { score: qa.score ?? null, notes: qa.notes ?? [] } : { score: null, notes: [] },
      scores: { surprise: sc.surprise ?? 0, stakes: sc.stakes ?? 0, reaction: sc.reaction ?? 0, cliffhanger: sc.cliffhanger ?? 0, context: sc.standalone ?? sc.context ?? 0, clarity: sc.clarity ?? 0, total: sc.total ?? null },
      scheduled_for: c.scheduled_for ?? null, variant: c.variant ?? null, type: c.kind, pinned_comment: c.pinned_comment ?? null,
      probe: !!c.probe && c.probe_state === "probe", rank: c.rank ?? null };                    // Probelauf: drei eigene Knöpfe statt Freigeben
  });
}

/** Nächster freier Slot des Accounts (heute/morgen) – für approve. */
async function nextFreeSlot(env: Env, account: string): Promise<string | null> {
  const cfg = accountsOf(env)[account];
  if (!cfg) return null;
  const rules = await accountRules(env, account);
  const now = new Date();
  const occ = (await db.all<any>(env,
    `SELECT p.scheduled_at, c.account, c.video_id FROM posts p JOIN clips c ON c.id = p.clip_id
     WHERE p.status IN ('scheduled','posted','shadow') AND p.scheduled_at >= ? AND p.scheduled_at <= ?`,
    new Date(now.getTime() - 2 * 86400000).toISOString(), new Date(now.getTime() + 3 * 86400000).toISOString()))
    .map((r) => ({ t: new Date(r.scheduled_at).getTime(), account: r.account, video_id: r.video_id ?? null, kind: null, day: String(r.scheduled_at).slice(0, 10) }));
  const free = planSlots(account, cfg.slots ?? [], rules.maxPerDay, occ, Number(env.POST_GAP_MIN || 90), rules.minGapMin, now);
  return free[0] ?? null;
}

export async function reviewAction(env: Env, clipId: string, body: { action: string; feedback?: string; tags?: string[]; caption?: string; hook?: string }, ws = "default") {
  const c = await db.first<any>(env, "SELECT c.*, ca.kind, ca.niche_id, ca.accounts AS camp_accounts FROM clips c JOIN campaigns ca ON ca.id = c.campaign_id WHERE c.id = ? AND c.workspace_id = ?", clipId, ws);
  if (!c) return { error: "clip not found" };
  const tags = Array.isArray(body.tags) ? body.tags.map(String).slice(0, 10) : [];
  const feedback = String(body.feedback ?? "").slice(0, 500);
  await db.run(env, "INSERT INTO feedback (workspace_id, clip_id, campaign_id, niche, account, action, tags, text, context_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ws, c.id, c.campaign_id, c.niche_id ?? null, c.account, body.action, JSON.stringify(tags), feedback || null, c.context_line ?? null);
  if (body.action === "edit") {
    const sets: string[] = [], vals: unknown[] = [];
    if (body.caption) { sets.push("caption = ?"); vals.push(String(body.caption).slice(0, 2200)); }
    if (body.hook) { sets.push("context_line = ?"); vals.push(String(body.hook).slice(0, 120)); }
    if (sets.length) await db.run(env, `UPDATE clips SET ${sets.join(", ")} WHERE id = ?`, ...vals, c.id);
    await logEvent(env, `review edit clip=${c.id}`, c.campaign_id);
    return { ok: true, action: "edit" };
  }
  if (body.action === "reject") {
    await db.run(env, "UPDATE posts SET status = 'cancelled' WHERE clip_id = ? AND status = 'shadow'", c.id);
    await db.run(env, "UPDATE clips SET status = 'rejected_review', note = ? WHERE id = ?", (tags.join(",") + " " + feedback).trim().slice(0, 200) || "review", c.id);
    await logEvent(env, `review reject clip=${c.id} tags=${tags.join(",")}`, c.campaign_id);
    return { ok: true, action: "reject" };
  }
  if (body.action === "redo") {
    await db.run(env, "UPDATE posts SET status = 'cancelled' WHERE clip_id = ? AND status = 'shadow'", c.id);
    await db.run(env, "UPDATE clips SET status = 'superseded', note = ? WHERE id = ?", ("redo: " + tags.join(",") + " " + feedback).trim().slice(0, 200), c.id);
    const account = c.kind === "fan" ? (parse<string[]>(c.camp_accounts, ["A", "B"])).join("") : c.account;
    const status = await dispatchClipJob(env, c.campaign_id, account, { feedback: [...tags, feedback].filter(Boolean).join("; ").slice(0, 400), preview: "true" });
    await logEvent(env, `review redo clip=${c.id} dispatch=${status} tags=${tags.join(",")}`, c.campaign_id);
    return { ok: status === 204, action: "redo", dispatch: status };
  }
  if (body.action === "approve") {
    if (c.status === "scheduled") return { ok: true, action: "approve", note: "already scheduled" };
    if (c.status === "shadow") { await db.run(env, "UPDATE posts SET status = 'cancelled' WHERE clip_id = ? AND status = 'shadow'", c.id); }
    await db.run(env, "UPDATE clips SET status = 'ready' WHERE id = ?", c.id);
    const slot = await nextFreeSlot(env, c.account);
    const r = await publishClipNow(env, c.id, slot);
    await logEvent(env, `review approve clip=${c.id} slot=${slot ?? "now"}`, c.campaign_id);
    return { ok: !("error" in r), action: "approve", slot, result: r };
  }
  return { error: `unknown action ${body.action}` };
}

/** Few-Shot-Hinweise aus dem bisherigen Feedback (für Momentwahl und QA in der Pipeline). */
export async function feedbackHints(env: Env, niche: string | null, ws = "default") {
  const rows = await db.all<any>(env, "SELECT action, tags, text, context_line FROM feedback WHERE workspace_id = ? AND (niche = ? OR ? IS NULL) ORDER BY id DESC LIMIT 40", ws, niche, niche);
  const tagCount: Record<string, number> = {};
  const examples: { action: string; context_line: string | null; text: string | null; tags: string[] }[] = [];
  for (const r of rows) {
    const tags = parse<string[]>(r.tags, []);
    for (const t of tags) tagCount[t] = (tagCount[t] ?? 0) + 1;
    if (examples.length < 12 && (r.text || tags.length)) examples.push({ action: r.action, context_line: r.context_line, text: r.text, tags });
  }
  return { tags: Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag, n]) => ({ tag, n })), examples };
}
