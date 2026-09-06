-- Fan-Content: Kampagnentyp, YouTube-Videokatalog (RSS + Backlog), Clip-Herkunft, Schattenmodus.
ALTER TABLE campaigns ADD COLUMN kind TEXT NOT NULL DEFAULT 'paid';   -- paid | fan

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,                       -- YouTube-Video-ID
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  title TEXT,
  url TEXT,
  published_at TEXT,                         -- ISO
  views INTEGER DEFAULT 0,
  duration_s INTEGER,
  is_short INTEGER DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'backlog',    -- rss (neu erschienen) | backlog (Katalog)
  status TEXT NOT NULL DEFAULT 'new',        -- new | queued | clipped | skipped | error
  campaign_id TEXT,                          -- fan-<id>, sobald ein Clip-Job gestartet wurde
  note TEXT,
  dispatched_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status, source, views);

ALTER TABLE clips ADD COLUMN video_id TEXT;        -- Quellvideo (nie zwei Clips desselben Videos am selben Tag)
ALTER TABLE clips ADD COLUMN rank INTEGER;         -- Moment-Rang aus dem Clipper (A: 1,3,5… B: 2,4,6…)
ALTER TABLE clips ADD COLUMN thumb_url TEXT;       -- Standbild in R2 (Telegram-Vorschau aus dem Worker)
CREATE INDEX IF NOT EXISTS idx_clips_video ON clips(video_id);

ALTER TABLE posts ADD COLUMN kind TEXT;            -- paid | fan (Snapshot für Reports)
ALTER TABLE posts ADD COLUMN mode TEXT NOT NULL DEFAULT 'live';   -- live | shadow | draft
