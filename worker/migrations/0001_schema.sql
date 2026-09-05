-- ClipForge Schema für Cloudflare D1 (SQLite). Mandantenfähig über workspace_id.
-- JSON-Spalten (footage, required, forbidden, accounts, platforms) sind TEXT mit JSON-Inhalt → json_extract().
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO workspaces (name) SELECT 'default' WHERE NOT EXISTS (SELECT 1 FROM workspaces);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,                       -- z.B. mrbeast-book-challenge
  workspace_id TEXT REFERENCES workspaces(id),
  platform TEXT NOT NULL,                    -- vyro | whop | ...
  name TEXT NOT NULL,
  external_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | joined | active | paused | ended
  rate_per_1k_usd REAL,
  min_views INTEGER DEFAULT 0,
  max_per_post_usd REAL,
  min_seconds INTEGER DEFAULT 0,
  footage TEXT NOT NULL DEFAULT '{}',        -- {type,url}
  required TEXT NOT NULL DEFAULT '{}',       -- caption, hashtags, overlay_text, tiktok flags
  forbidden TEXT NOT NULL DEFAULT '{}',
  accounts TEXT NOT NULL DEFAULT '["A","B"]',
  platforms TEXT NOT NULL DEFAULT '["tiktok"]',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  campaign_id TEXT REFERENCES campaigns(id),
  account TEXT NOT NULL,
  media_url TEXT NOT NULL,
  caption TEXT,
  hook_type TEXT,
  status TEXT NOT NULL DEFAULT 'ready',      -- ready | scheduled | posted | submitted | archived | rejected_precheck | rejected_platform
  note TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_clips_status_account ON clips(status, account);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  clip_id TEXT REFERENCES clips(id),
  platform TEXT NOT NULL,                    -- tiktok | instagram | youtube
  blotato_submission_id TEXT,
  post_url TEXT,
  scheduled_at TEXT,
  posted_at TEXT,
  submitted_at TEXT,                         -- bei Vyro eingereicht (manuell bestätigt)
  views_24h INTEGER, views_72h INTEGER, views_7d INTEGER,
  status TEXT DEFAULT 'scheduled',           -- scheduled | posted | error | rejected_platform
  rejection_reason TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_clip ON posts(clip_id);

CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  kind TEXT,                                 -- blotato | llm | other
  amount_usd REAL,
  ref TEXT,
  at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT REFERENCES campaigns(id),
  amount_usd REAL,
  source TEXT,                               -- email | manual
  at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT,
  event TEXT,
  at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);

CREATE TABLE IF NOT EXISTS account_state (
  account TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO account_state(account) VALUES ('A'),('B');

-- Dashboard-Views
CREATE VIEW IF NOT EXISTS v_clip_performance AS
SELECT c.campaign_id, c.account, c.hook_type, p.platform,
       COUNT(*) AS posts, AVG(p.views_7d) AS avg_views_7d,
       SUM(CASE WHEN p.views_7d >= COALESCE(ca.min_views,0) THEN 1 ELSE 0 END) AS qualified
FROM posts p JOIN clips c ON c.id = p.clip_id JOIN campaigns ca ON ca.id = c.campaign_id
GROUP BY 1,2,3,4;

CREATE VIEW IF NOT EXISTS v_profit_weekly AS
SELECT strftime('%Y-W%W', pay.at) AS week,
       SUM(pay.amount_usd) AS revenue_usd,
       (SELECT COALESCE(SUM(amount_usd),0) FROM costs WHERE strftime('%Y-W%W', at) = strftime('%Y-W%W', pay.at)) AS cost_usd
FROM payouts pay GROUP BY 1 ORDER BY 1 DESC;
