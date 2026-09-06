-- Nachtrag 3: Chat – Konversationen und Nachrichten je Workspace, Tagesbudget.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  title TEXT,
  context TEXT,                              -- JSON {page, niche, account}
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  role TEXT NOT NULL,                        -- user | assistant
  content TEXT NOT NULL,
  meta TEXT,                                 -- JSON {tier, model, sources, action, usd, tokens}
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS chat_usage (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,                         -- YYYY-MM-DD (UTC)
  usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
CREATE TABLE IF NOT EXISTS chat_actions (   -- vorgeschlagene Aktionen, Ausführung erst nach Bestätigung (confirm_token)
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  conversation_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,                        -- JSON
  label TEXT,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',   -- proposed | confirmed | cancelled | failed
  result TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  executed_at TEXT
);
