// Mandantenfähigkeit (Stufe 7): Workspace aus dem Lese-Key auflösen, Konfiguration je Workspace (Accounts/Nischen) in env einblenden,
// Verwaltung über den Admin-API-Key (/api/workspaces). Login später über Cloudflare Access – jetzt nur die Datentrennung.
import { Env, db, keyMatches, nowIso, logEvent } from "./shared";

export interface Workspace { id: string; name: string; created_at: string; has_key: boolean; has_config: boolean }

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** env-Kopie mit der Workspace-Konfiguration (ACCOUNTS_JSON) – alle Module lesen accountsOf(env)/nichesOf(env) unverändert. */
export async function envFor(env: Env, ws: string): Promise<Env> {
  if (ws === "default") return env;
  const row = await db.first<{ config: string | null }>(env, "SELECT config FROM workspaces WHERE id = ?", ws);
  return { ...env, ACCOUNTS_JSON: row?.config || "{}", WS: ws } as Env;
}

/** Lese-Key → Workspace. Worker-Secret DASHBOARD_READ_KEY = Workspace 'default'; sonst workspaces.read_key_hash.
 *  Der Admin-Key (CLIPFORGE_API_KEY) darf jeden Workspace über ?ws= / Header x-workspace ansprechen (Standard 'default'). */
export async function resolveWorkspace(env: Env, given: string, requested?: string | null): Promise<{ ws: string; env: Env; admin: boolean } | null> {
  if (!given) return null;
  if (keyMatches(given, env.CLIPFORGE_API_KEY)) {
    const ws = requested || "default";
    if (ws !== "default" && !(await db.first(env, "SELECT id FROM workspaces WHERE id = ?", ws))) return null;
    return { ws, env: await envFor(env, ws), admin: true };
  }
  if (keyMatches(given, env.DASHBOARD_READ_KEY)) return { ws: "default", env, admin: false };
  const row = await db.first<{ id: string }>(env, "SELECT id FROM workspaces WHERE read_key_hash = ?", await sha256(given));
  if (!row) return null;
  return { ws: row.id, env: await envFor(env, row.id), admin: false };
}

export async function listWorkspaces(env: Env): Promise<Workspace[]> {
  const rows = await db.all<any>(env, "SELECT id, name, created_at, read_key_hash, config FROM workspaces ORDER BY created_at");
  return rows.map((r) => ({ id: r.id, name: r.name, created_at: r.created_at, has_key: !!r.read_key_hash, has_config: !!r.config }));
}

/** Workspace anlegen: id (Slug), Name, optional config (JSON wie ACCOUNTS_JSON). Gibt den Lese-Key einmalig zurück. */
export async function createWorkspace(env: Env, body: { id?: string; name?: string; config?: unknown }): Promise<{ ok: boolean; error?: string; id?: string; read_key?: string }> {
  const id = String(body.id ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!id || id === "default") return { ok: false, error: "id fehlt oder reserviert (a-z, 0-9, -)" };
  if (await db.first(env, "SELECT id FROM workspaces WHERE id = ?", id)) return { ok: false, error: `Workspace ${id} existiert` };
  const name = String(body.name ?? id).slice(0, 80);
  const config = body.config ? JSON.stringify(body.config) : null;
  const key = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.run(env, "INSERT INTO workspaces (id, name, read_key_hash, config, created_at) VALUES (?, ?, ?, ?, ?)", id, name, await sha256(key), config, nowIso());
  await db.run(env, "INSERT OR IGNORE INTO settings (workspace_id, key, value, version, updated_at) VALUES (?, 'global', ?, 1, ?)", id, JSON.stringify({ shadow: true }), nowIso());   // neue Workspaces starten im Schatten
  await logEvent(env, `workspace_created ${id}`);
  return { ok: true, id, read_key: key };
}

export async function patchWorkspace(env: Env, id: string, body: { name?: string; config?: unknown; rotate_key?: boolean }): Promise<{ ok: boolean; error?: string; read_key?: string }> {
  const row = await db.first<any>(env, "SELECT id FROM workspaces WHERE id = ?", id);
  if (!row) return { ok: false, error: "nicht gefunden" };
  if (body.name !== undefined) await db.run(env, "UPDATE workspaces SET name = ? WHERE id = ?", String(body.name).slice(0, 80), id);
  if (body.config !== undefined) await db.run(env, "UPDATE workspaces SET config = ? WHERE id = ?", body.config ? JSON.stringify(body.config) : null, id);
  let read_key: string | undefined;
  if (body.rotate_key && id !== "default") {
    read_key = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await db.run(env, "UPDATE workspaces SET read_key_hash = ? WHERE id = ?", await sha256(read_key), id);
  }
  await logEvent(env, `workspace_updated ${id}${read_key ? " key rotated" : ""}`);
  return { ok: true, read_key };
}
