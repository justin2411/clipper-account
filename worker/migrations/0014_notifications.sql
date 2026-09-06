-- Nachtrag 2: Benachrichtigungszentrale – Spiegel jeder Telegram-Nachricht (Text/Foto) je Workspace, mit Gelesen/Erledigt.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL DEFAULT 'info',         -- report | supply | new_video | upload | clip_job | submit | preview | warning | error | killswitch | test | info
  title TEXT NOT NULL,                       -- erste Zeile
  text TEXT NOT NULL,                        -- vollständiger Text
  photo_url TEXT,
  sent_telegram INTEGER NOT NULL DEFAULT 0,  -- 1 = an Telegram gesendet (Regel je Ereignistyp)
  read INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_ws ON notifications(workspace_id, done, read, id);
