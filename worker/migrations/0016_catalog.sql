-- Nachschub-Agent mit Archiv: Bewertung je Video, Sperrliste der schon verwendeten Stellen, technische Merkmale.
-- Der Katalog bleibt in videos (eine Quelle der Wahrheit); „sources" heißt im System weiterhin die Upload-/Footage-Zeile.
ALTER TABLE videos ADD COLUMN height INTEGER;              -- echte Auflösung der Quelle, erst beim Download bekannt
ALTER TABLE videos ADD COLUMN rating TEXT;                 -- JSON der Modellbewertung (Momente, Passung, Bildqualität, totgeklippt)
ALTER TABLE videos ADD COLUMN score REAL;                  -- 0–10 Gesamtbewertung, geht ins Archiv-Ranking (Aufrufe × Bewertung)
ALTER TABLE videos ADD COLUMN fit_a REAL;                  -- Passung zu Account A (krasse Momente)
ALTER TABLE videos ADD COLUMN fit_b REAL;                  -- Passung zu Account B (Crew-Reaktionen)
ALTER TABLE videos ADD COLUMN overclipped INTEGER;         -- 1 = wirkt totgeklippt, wird nicht vorgeschlagen
ALTER TABLE videos ADD COLUMN rated_at TEXT;

-- Sperrliste: jede verwendete Stelle eines Quellvideos mit Zeitstempel.
-- Kein Video zweimal in 90 Tagen, nie dieselbe Stelle zweimal.
CREATE TABLE IF NOT EXISTS video_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  video_id TEXT NOT NULL,
  clip_id TEXT,
  account TEXT,
  start_s REAL,
  end_s REAL,
  used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_video_usage_video ON video_usage(workspace_id, video_id);
CREATE INDEX IF NOT EXISTS idx_video_usage_at ON video_usage(workspace_id, used_at);
CREATE INDEX IF NOT EXISTS idx_videos_rank ON videos(workspace_id, status, published_at);
