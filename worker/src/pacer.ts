// Taktgeber (Beobachtungsmodus): schlägt je Account ein posts_per_day vor und schreibt die Begründung ins Ereignis-Log.
// Er ändert nichts – keine Einstellung, kein Slot, keine Pause. Es gibt bewusst keinen Schreibpfad: soll er später scharf
// geschaltet werden, kommt der Vorschlag als bestätigbare Aktion in den Chat (update_settings), nicht als stiller Schreibzugriff.
//
// Signale je Account (alle aus D1, nichts geschätzt):
//   • Trend der Views (letzte 10 Posts gegen die 10 davor) und Anteil unter 200 Views – aus der Account-Gesundheit
//   • tatsächlicher Takt der letzten 7 Tage (Posts pro Tag) gegen den eingestellten Wert
//   • Fan-Vorrat in Tagen (fertige Clips ÷ eingestelltem Tagespensum)
//   • Pausen-Zustand und Ampelfarbe
//   • Plattform-Limit (nie darüber) und die Spanne 1 bis 8
// Ohne Kennzahlen gibt es keinen Vorschlag: dann steht im Log, dass die Datenlage fehlt.
import { Env, db, nowIso, logEvent } from "./shared";
import { accountsOf } from "./publisher";
import { effectiveSettings, PLATFORM_MAX_PER_DAY } from "./settings";
import { accountHealth } from "./health";
import { fanStock } from "./fan";

export interface PacerProposal {
  account: string; current: number; proposed: number; delta: number;
  confident: boolean;                    // true = Kennzahlen lagen vor; false = nur Vorrat und Zustand
  basis: "kennzahlen" | "vorrat";
  reasons: string[]; data: {
    posts_7d: number; rate_7d: number | null; posts_with_views: number; trend_pct: number | null; under_200_pct: number | null;
    stock_days: number | null; color: string; paused: boolean; platform_limit: number;
  };
}
export interface PacerRun { at: string; mode: "observe"; proposals: PacerProposal[] }

const r1 = (n: number) => Math.round(n * 10) / 10;

export async function buildPacer(env: Env, ws = "default"): Promise<PacerRun> {
  const stock = await fanStock(env).catch(() => ({} as Record<string, { ready: number; target: number }>));
  const proposals: PacerProposal[] = [];
  for (const [id, cfg] of Object.entries(accountsOf(env)) as [string, any][]) {
    const eff = await effectiveSettings(env, id, ws).catch(() => null);
    const current = Number(eff?.settings.posts_per_day ?? env.MAX_CLIPS_PER_DAY ?? 5);
    const platforms: string[] = eff?.settings.platforms ?? cfg.platforms ?? ["tiktok"];
    const limit = Math.min(8, ...platforms.map((p) => PLATFORM_MAX_PER_DAY[p] ?? 10));
    const h = await accountHealth(env, id, ws).catch(() => null);
    const week = await db.first<{ n: number }>(env,
      `SELECT COUNT(*) AS n FROM posts p JOIN clips c ON c.id = p.clip_id
       WHERE p.workspace_id = ? AND c.account = ? AND p.status IN ('posted','submitted') AND p.mode != 'shadow'
         AND p.posted_at >= ?`, ws, id, new Date(Date.now() - 7 * 86400000).toISOString());
    const posts7 = Number(week?.n ?? 0);
    const st = stock[id];
    const stockDays = st && current > 0 ? r1(st.ready / current) : null;
    const reasons: string[] = [];
    let delta = 0, confident = true;

    if (!h || h.metrics.posts_with_views === 0) {                       // ohne Kennzahlen wird nicht getaktet
      confident = false;                                                // Vorschlag stützt sich dann nur auf Vorrat und Zustand
      reasons.push("Keine Views in D1 – Blotato liefert für diesen Account noch keine Kennzahlen; der Vorschlag stützt sich nur auf Vorrat und Zustand.");
    } else {
      const trend = h.metrics.trend_pct, under = h.metrics.under_200_pct;
      if (trend != null && trend <= -30) { delta -= 1; reasons.push(`Views je Post fallen um ${Math.abs(trend)} % gegenüber den zehn Posts davor.`); }
      else if (trend != null && trend >= 30) { delta += 1; reasons.push(`Views je Post steigen um ${trend} % gegenüber den zehn Posts davor.`); }
      if (under != null && under >= 60) { delta -= 1; reasons.push(`${under} % der letzten zehn Posts bleiben unter 200 Views.`); }
    }
    if (stockDays != null && stockDays < 1) { delta = Math.min(delta, -1); reasons.push(`Fan-Vorrat reicht nur ${stockDays} Tage – mehr posten als nachwächst leert das Lager.`); }
    else if (stockDays != null && stockDays >= Number(eff?.settings.stock_days ?? 2) && h?.color === "green" && delta >= 0 && confident) {
      delta += 1; reasons.push(`Vorrat reicht ${stockDays} Tage und die Ampel steht auf grün.`);
    }
    if (h?.metrics.paused) { delta = Math.min(delta, 0); reasons.push(`Account ist pausiert${h.metrics.pause_reason ? ` (${h.metrics.pause_reason})` : ""} – keine Erhöhung.`); }
    if (h?.color === "red") { delta = Math.min(delta, 0); reasons.push("Ampel steht auf rot – erst erholen, dann erhöhen."); }

    const proposed = Math.max(1, Math.min(limit, current + (confident || delta < 0 ? delta : 0)));
    if (proposed === current && !reasons.length) reasons.push("Trend, Vorrat und Ampel geben keinen Anlass zu ändern.");
    if (proposed === current && !confident) reasons.push("Ohne Kennzahlen bleibt es beim eingestellten Wert.");
    if (posts7 && r1(posts7 / 7) < current * 0.6)
      reasons.push(`Hinweis: tatsächlich ${r1(posts7 / 7)} Posts pro Tag in den letzten sieben Tagen, eingestellt sind ${current}.`);
    proposals.push({
      account: id, current, proposed, delta: proposed - current, confident, basis: confident ? "kennzahlen" : "vorrat", reasons,
      data: { posts_7d: posts7, rate_7d: posts7 ? r1(posts7 / 7) : null, posts_with_views: h?.metrics.posts_with_views ?? 0,
              trend_pct: h?.metrics.trend_pct ?? null, under_200_pct: h?.metrics.under_200_pct ?? null,
              stock_days: stockDays, color: h?.color ?? "grey", paused: !!h?.metrics.paused, platform_limit: limit },
    });
  }
  return { at: nowIso(), mode: "observe", proposals };
}

/** Täglich (im notify-Lauf): Vorschläge bilden, Begründung ins Ereignis-Log – nur wenn sich etwas gegenüber gestern geändert hat. */
export async function runPacer(env: Env, ws = "default") {
  const run = await buildPacer(env, ws);
  const prev = await lastPacer(env, ws);
  let logged = 0;
  for (const p of run.proposals) {
    const before = (prev?.proposals ?? []).find((x: PacerProposal) => x.account === p.account);
    const same = before && before.proposed === p.proposed && before.current === p.current && before.reasons.join("|") === p.reasons.join("|");
    if (same) continue;
    await logEvent(env, `pacer ${p.account} vorschlag=${p.proposed} (aktuell ${p.current}) basis=${p.basis} beobachtungsmodus, nichts geändert · ${p.reasons.join(" ")}`.slice(0, 480));
    logged++;
  }
  await db.run(env, "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
               `pacer:${ws}`, JSON.stringify(run), nowIso());
  return { mode: run.mode, accounts: run.proposals.length, logged, proposals: run.proposals.map((p) => ({ account: p.account, current: p.current, proposed: p.proposed })) };
}

export async function lastPacer(env: Env, ws = "default"): Promise<PacerRun | null> {
  const r = await db.first<{ value: string }>(env, "SELECT value FROM kv WHERE key = ?", `pacer:${ws}`);
  try { return r ? (JSON.parse(r.value) as PacerRun) : null; } catch { return null; }
}
