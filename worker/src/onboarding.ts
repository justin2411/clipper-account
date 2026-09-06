// Onboarding-Checkliste (Stufe 6): sechs Schritte beim ersten Start eines Workspaces, Status aus den echten Daten
// (Secrets/Konfiguration, D1). Wird auf der Übersicht gezeigt, bis alle Schritte erledigt sind; danach unter #start abrufbar.
import { Env, db, nichesOf } from "./shared";
import { accountsOf } from "./publisher";
import { effectiveSettings } from "./settings";

export interface OnboardingStep { key: string; label: string; done: boolean; detail: string; href: string; hint?: string }
export interface Onboarding { steps: OnboardingStep[]; done: number; total: number; complete: boolean }

export async function onboardingStatus(env: Env, ws = "default"): Promise<Onboarding> {
  const accounts = Object.entries(accountsOf(env));
  const niches = nichesOf(env);
  const withBlotato = accounts.filter(([, a]: [string, any]) => a?.blotato && Object.values(a.blotato).some(Boolean));
  const paidCamps = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM campaigns WHERE workspace_id = ? AND COALESCE(kind,'paid') = 'paid'", ws);
  const versions = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM settings_versions WHERE workspace_id = ?", ws);
  const shadowPosts = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM posts WHERE workspace_id = ? AND (mode = 'shadow' OR status = 'shadow')", ws);
  const livePosts = await db.first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM posts WHERE workspace_id = ? AND status IN ('posted','submitted') AND mode = 'live'", ws);
  const fanShadow = (env.PUBLISH_MODE_FAN ?? "").toLowerCase() === "shadow";
  const g = await db.first<{ value: string }>(env, "SELECT value FROM settings WHERE workspace_id = ? AND key = 'global'", ws);
  const shadowFlag = g ? !!JSON.parse(g.value || "{}").shadow : fanShadow;

  const fonts: string[] = [];
  for (const [id] of accounts) { try { fonts.push(`${id}: ${(await effectiveSettings(env, id, ws)).settings.visual.font}`); } catch { /* optional */ } }
  const steps: OnboardingStep[] = [
    { key: "accounts", label: "Accounts verbinden (Blotato)", done: !!env.BLOTATO_API_KEY && withBlotato.length > 0 && withBlotato.length === accounts.length,
      detail: !env.BLOTATO_API_KEY ? "BLOTATO_API_KEY fehlt im Worker" : `${withBlotato.length} von ${accounts.length} Accounts mit Blotato-ID (${withBlotato.map(([id]) => id).join(", ") || "–"})`,
      href: "#how", hint: "config/accounts.yaml: blotato.tiktok je Account, dann scripts/accounts_json.py → Worker-Secret ACCOUNTS_JSON" },
    { key: "vyro", label: "Vyro-Konto verknüpfen (Mail-Scout)", done: !!env.GMAIL_REFRESH_TOKEN,
      detail: env.GMAIL_REFRESH_TOKEN ? `Gmail verbunden · ${paidCamps?.n ?? 0} Kampagnen erkannt` : "Gmail-Token fehlt – Kampagnen-Mails werden nicht gelesen",
      href: "#pipeline", hint: "scripts/gmail_auth.py ausführen, Refresh-Token als Worker-Secret GMAIL_REFRESH_TOKEN" },
    { key: "niche", label: "Kategorie anlegen", done: niches.length > 0,
      detail: niches.length ? niches.map((n) => `${n.label} (${n.accounts.join(", ")})`).join(" · ") : "Noch keine Nische in config/accounts.yaml",
      href: niches[0] ? `#n:${niches[0].key}` : "#home" },
    { key: "look", label: "Look wählen", done: (versions?.n ?? 0) > 0,
      detail: (versions?.n ?? 0) > 0 ? `${versions?.n} gespeicherte Stände · Schrift ${fonts.join(", ") || "Standard"}` : "Feinjustierung noch nie gespeichert (Standard-Look aktiv)",
      href: "#settings" },
    { key: "shadow", label: "Schattenmodus testen", done: (shadowPosts?.n ?? 0) > 0,
      detail: (shadowPosts?.n ?? 0) > 0 ? `${shadowPosts?.n} Schatten-Posts geprüft · Fan-Content ${fanShadow || shadowFlag ? "läuft im Schatten" : "live"}` : "Noch kein Schatten-Post – Clip in der Clip-Vorschau freigeben, solange Schatten aktiv ist",
      href: "#review" },
    { key: "live", label: "Live", done: (livePosts?.n ?? 0) > 0,
      detail: (livePosts?.n ?? 0) > 0 ? `${livePosts?.n} Posts live veröffentlicht` : "Noch nichts live – Schalter „Live“ in der Feinjustierung oder PUBLISH_MODE=live",
      href: "#settings" },
  ];
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length };
}
