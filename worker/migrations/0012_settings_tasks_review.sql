-- Dashboard-Ausbau Stufe 1: Einstellungen (Nische → Account-Override), Aufgaben, Review-Feedback (Few-Shot).
CREATE TABLE IF NOT EXISTS settings (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,                         -- 'global' | 'niche:<key>' | 'account:<id>'
  value TEXT NOT NULL,                       -- JSON
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, key)
);
CREATE TABLE IF NOT EXISTS settings_versions (   -- letzte Stände für „Zurücksetzen“ (Stufe 3)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  snapshot TEXT NOT NULL,                    -- JSON des gesamten Settings-Objekts
  diff TEXT,                                 -- JSON [{field, old, new, accounts}]
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(6)))),
  workspace_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,                        -- submit | join | footage | review | calibrate
  ref TEXT NOT NULL,                         -- eindeutiger Bezug (campaign id, niche key, account id) → keine Duplikate
  title TEXT NOT NULL,
  detail TEXT,
  niche TEXT,
  campaign_id TEXT,
  campaign_url TEXT,
  urls TEXT NOT NULL DEFAULT '[]',
  auto_check INTEGER NOT NULL DEFAULT 1,
  done INTEGER NOT NULL DEFAULT 0,
  done_by TEXT,                              -- auto | user
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_ref ON tasks(workspace_id, kind, ref);
CREATE TABLE IF NOT EXISTS feedback (          -- Review-Feedback je Clip; Tags/Text fließen als Few-Shot in Momentwahl und QA
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  clip_id TEXT,
  campaign_id TEXT,
  niche TEXT,
  account TEXT,
  action TEXT NOT NULL,                      -- approve | reject | redo | edit
  tags TEXT NOT NULL DEFAULT '[]',
  text TEXT,
  context_line TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE clips ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE posts ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE uploads ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE videos ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE events ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE account_state ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE account_stats ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE payouts ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
INSERT OR IGNORE INTO workspaces (id, name) VALUES ('default', 'default');   -- fester Workspace-Schlüssel (campaigns.workspace_id → workspaces.id)
UPDATE campaigns SET workspace_id = 'default' WHERE workspace_id IS NULL;
UPDATE costs SET workspace_id = 'default' WHERE workspace_id IS NULL;
