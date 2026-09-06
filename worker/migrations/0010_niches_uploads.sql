-- Footage-Uploads aus dem Dashboard (Nischen-Seite) und Account-Statistiken (Blotato-Analytics-Snapshots).
-- Nischen selbst stehen in config/accounts.yaml (→ ACCOUNTS_JSON._niches), Fan-Kampagnen entstehen nur noch aus Uploads.
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  niche_id TEXT NOT NULL,
  key TEXT NOT NULL,                         -- R2-Key (uploads/<niche>/<id>/<name>.mp4)
  title TEXT,
  size INTEGER,
  kind TEXT NOT NULL DEFAULT 'fan',          -- fan | paid (Upload für eine bestehende paid-Kampagne)
  video_id TEXT,                             -- optional: YouTube-ID aus dem Backlog (Titel/Aufrufe)
  upload_id TEXT,                            -- R2 Multipart-Upload-ID
  parts TEXT NOT NULL DEFAULT '[]',          -- JSON [{partNumber, etag}]
  status TEXT NOT NULL DEFAULT 'uploading',  -- uploading | uploaded | dispatched | clipped | error
  campaign_id TEXT,
  note TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status, created_at);

CREATE TABLE IF NOT EXISTS account_stats (   -- Tages-Snapshot je Account (Tracker, Blotato-Analytics)
  account TEXT NOT NULL,
  day TEXT NOT NULL,                         -- YYYY-MM-DD
  followers INTEGER,
  views_7d INTEGER,
  views_30d INTEGER,
  likes_30d INTEGER,
  posts_7d INTEGER,
  raw TEXT,
  PRIMARY KEY (account, day)
);

ALTER TABLE campaigns ADD COLUMN niche_id TEXT;
ALTER TABLE videos ADD COLUMN niche_id TEXT;
UPDATE videos SET niche_id = 'mrbeast' WHERE niche_id IS NULL;
UPDATE campaigns SET niche_id = 'mrbeast' WHERE niche_id IS NULL;
DELETE FROM kv WHERE key = 'yt_cookies';
ALTER TABLE posts ADD COLUMN views INTEGER;          -- aktuellster Stand aus Blotato-Analytics (Tracker)
ALTER TABLE posts ADD COLUMN likes INTEGER;
ALTER TABLE posts ADD COLUMN metrics_at TEXT;
ALTER TABLE posts ADD COLUMN blotato_post_id TEXT;   -- ID des veröffentlichten Posts (für /v2/posts/{id}/analytics)
