-- Fortschritt, Lebenszeichen und Abbrechen je Job-Stufe.
-- Eine Zeile je (Kampagne, Stufe): der laufende Job schreibt alle 30 Sekunden einen Zeitstempel.
-- Kommt zehn Minuten nichts, gilt die Stufe als „hängt"; nach zwei Stunden räumt der Cron sie auf failed.
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  campaign_id TEXT,
  upload_id TEXT,
  run_id TEXT,                       -- Actions-Lauf, für Link und Abbruch
  account TEXT,
  stage TEXT NOT NULL,               -- download | transcript | moments | cut | render | qa
  status TEXT NOT NULL DEFAULT 'running',   -- running | done | failed | cancelled
  progress REAL,                     -- 0..1, nur wo echt messbar
  detail TEXT,                       -- z.B. „412 von 1620 s"
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_campaign ON job_runs(workspace_id, campaign_id, stage);
CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(workspace_id, status, heartbeat_at);
