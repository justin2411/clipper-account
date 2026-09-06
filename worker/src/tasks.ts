// Aufgaben: automatisch anlegen (submit / join / footage / review) und automatisch abhaken, sobald das System das Ergebnis sieht.
import { Env, db, logEvent, nichesOf, telegram } from "./shared";
import { accountsOf } from "./publisher";
import { fanStock } from "./fan";

const nowIso = () => new Date().toISOString();

async function upsertTask(env: Env, t: { kind: string; ref: string; title: string; detail?: string; niche?: string; campaign_id?: string; campaign_url?: string; urls?: string[]; auto_check?: boolean }, ws = "default") {
  const cur = await db.first<any>(env, "SELECT * FROM tasks WHERE workspace_id = ? AND kind = ? AND ref = ?", ws, t.kind, t.ref);
  if (cur) {
    if (cur.done) return cur;                                       // erledigt bleibt erledigt (bis ein neuer Bezug entsteht)
    await db.run(env, "UPDATE tasks SET title = ?, detail = ?, urls = ?, campaign_url = ? WHERE id = ?", t.title, t.detail ?? null, JSON.stringify(t.urls ?? []), t.campaign_url ?? null, cur.id);
    return cur;
  }
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  await db.run(env, "INSERT INTO tasks (id, workspace_id, kind, ref, title, detail, niche, campaign_id, campaign_url, urls, auto_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, ws, t.kind, t.ref, t.title, t.detail ?? null, t.niche ?? null, t.campaign_id ?? null, t.campaign_url ?? null, JSON.stringify(t.urls ?? []), t.auto_check === false ? 0 : 1);
  await logEvent(env, `task_created kind=${t.kind} ref=${t.ref}`);
  return { id, kind: t.kind };
}

export async function completeTask(env: Env, id: string, by: "auto" | "user" = "user") {
  const r = await db.run(env, "UPDATE tasks SET done = 1, done_by = ?, done_at = ? WHERE id = ? AND done = 0", by, nowIso(), id);
  if (r.meta.changes) await logEvent(env, `task_done id=${id} by=${by}`);
  return r.meta.changes > 0;
}

async function completeByRef(env: Env, kind: string, ref: string, ws = "default") {
  const t = await db.first<any>(env, "SELECT id FROM tasks WHERE workspace_id = ? AND kind = ? AND ref = ? AND done = 0", ws, kind, ref);
  if (t) await completeTask(env, t.id, "auto");
}

/** Bestand synchronisieren: neue Aufgaben anlegen, erledigte automatisch abhaken. Läuft im Scout-Cron und vor /dashboard. */
export async function syncTasks(env: Env, ws = "default") {
  const niches = nichesOf(env), accounts = accountsOf(env);
  const nicheOfCampaign = (c: any) => c.niche_id ?? niches[0]?.key ?? "";
  // submit: gepostete, nicht eingereichte Posts je paid-Kampagne
  const camps = await db.all<any>(env, "SELECT * FROM campaigns WHERE kind = 'paid'");
  for (const c of camps) {
    const open = await db.all<any>(env,
      `SELECT p.post_url, cl.account FROM posts p JOIN clips cl ON cl.id = p.clip_id
       WHERE cl.campaign_id = ? AND p.status = 'posted' AND p.post_url IS NOT NULL AND p.post_url != '' AND p.submitted_at IS NULL ORDER BY p.posted_at`, c.id);
    if (open.length && ["active", "joined"].includes(c.status)) {
      const accs = [...new Set(open.map((o) => o.account))].join(" + ");
      await upsertTask(env, { kind: "submit", ref: c.id, title: `${open.length} Post-Link${open.length > 1 ? "s" : ""} bei ${c.platform === "vyro" ? "Vyro" : c.platform} einreichen`,
        detail: `${c.name} · Account ${accs}`, niche: nicheOfCampaign(c), campaign_id: c.id, campaign_url: c.external_url || "https://app.vyro.com/campaigns", urls: open.map((o) => o.post_url) }, ws);
    } else await completeByRef(env, "submit", c.id, ws);
    // join: Kampagnen-Entwurf ohne Footage
    if (c.status === "draft") {
      await upsertTask(env, { kind: "join", ref: c.id, title: `Neue Kampagne: ${c.name}`, detail: `${c.platform} · ${c.rate_per_1k_usd ? c.rate_per_1k_usd + " $/1k · " : ""}Join + Footage-Link setzen`,
        niche: nicheOfCampaign(c), campaign_id: c.id, campaign_url: c.external_url || "https://app.vyro.com/campaigns" }, ws);
    } else await completeByRef(env, "join", c.id, ws);
  }
  // footage: Vorrat unter 2 Tagen je Nische
  const stock = await fanStock(env);
  for (const n of niches) {
    const per = n.accounts.map((a) => stock[a]).filter(Boolean);
    const daysLeft = per.length ? Math.min(...per.map((s) => (s.target ? (s.ready / (s.target / Number(env.STOCK_DAYS || 3))) : 0))) : 99;
    const inflight = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM uploads WHERE niche_id = ? AND status IN ('uploading','uploaded','dispatched') AND created_at >= ?", n.key, new Date(Date.now() - 6 * 3600000).toISOString());
    if (daysLeft < 2 && !(inflight?.n ?? 0)) {
      await upsertTask(env, { kind: "footage", ref: n.key, title: `Nachschub für ${n.label}`, detail: `Fan-Vorrat reicht noch ${daysLeft.toFixed(1)} Tage · Video für ${n.accounts.join(" + ")} hochladen`, niche: n.key }, ws);
    } else if (daysLeft >= 2) await completeByRef(env, "footage", n.key, ws);
  }
  // review: pausierte Accounts (Kill-Switch / Ablehnung), nicht die geplanten Pausen
  const paused = await db.all<any>(env, "SELECT * FROM account_state WHERE paused = 1");
  for (const [id] of Object.entries(accounts)) {
    const st = paused.find((p) => p.account === id);
    if (st && ["rejection", "views_drop"].includes(String(st.reason))) {
      const n = niches.find((x) => x.accounts.includes(id));
      await upsertTask(env, { kind: "review", ref: id, title: `Account ${id} prüfen (${st.reason === "rejection" ? "Ablehnung mit Spam/Automation-Grund" : "Views-Einbruch"})`,
        detail: `${accounts[id]?.handle ?? id} pausiert · Profil ansehen, dann freigeben`, niche: n?.key }, ws);
    } else await completeByRef(env, "review", id, ws);
  }
}

export async function listTasks(env: Env, ws = "default") {
  const rows = await db.all<any>(env, "SELECT * FROM tasks WHERE workspace_id = ? AND done = 0 ORDER BY created_at DESC LIMIT 50", ws);
  return rows.map((t) => ({ id: t.id, kind: t.kind, title: t.title, detail: t.detail ?? "", niche: t.niche ?? null, campaign_id: t.campaign_id ?? null, campaign_url: t.campaign_url ?? null,
    urls: (() => { try { return JSON.parse(t.urls || "[]"); } catch { return []; } })(), created: t.created_at, auto_check: !!t.auto_check, done: false, account: t.kind === "review" ? t.ref : undefined }));
}

/** Kill-Switch aufheben (Dashboard-Knopf). */
export async function resumeAccount(env: Env, account: string) {
  await db.run(env, "UPDATE account_state SET paused = 0, reason = NULL, paused_until = NULL, updated_at = ? WHERE account = ?", nowIso(), account);
  await completeByRef(env, "review", account);
  await logEvent(env, `account_resumed ${account} (dashboard)`);
  await telegram(env, `▶️ Account ${account} wieder freigegeben (Dashboard).`);
  return { account, paused: 0 };
}
