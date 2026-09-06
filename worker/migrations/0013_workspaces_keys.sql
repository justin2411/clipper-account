-- Stufe 7: Mandantenfähigkeit – Lese-Key und Konfiguration je Workspace.
-- read_key_hash: SHA-256 des Dashboard-Lese-Keys (der Key selbst wird nur einmal beim Anlegen zurückgegeben).
-- config: JSON wie ACCOUNTS_JSON (Accounts + _niches) für diesen Workspace; NULL = Worker-Secret ACCOUNTS_JSON (Workspace 'default').
ALTER TABLE workspaces ADD COLUMN read_key_hash TEXT;
ALTER TABLE workspaces ADD COLUMN config TEXT;
INSERT OR IGNORE INTO workspaces (id, name) VALUES ('default', 'default');
CREATE INDEX IF NOT EXISTS idx_workspaces_key ON workspaces(read_key_hash);
