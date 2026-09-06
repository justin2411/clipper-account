-- Probelauf je Quellvideo: erst zwei Momente, dann entscheidet der Mensch.
-- Kein Zeitablauf, keine automatische Freigabe – ohne Entscheidung passiert nichts.
ALTER TABLE campaigns ADD COLUMN probe_state TEXT;      -- probe | released | rejected (nur Fan-Kampagnen)
ALTER TABLE clips ADD COLUMN probe INTEGER DEFAULT 0;   -- 1 = aus einem Probelauf
ALTER TABLE videos ADD COLUMN probe_round INTEGER DEFAULT 0;
ALTER TABLE videos ADD COLUMN blocked_ranks TEXT;       -- JSON-Liste bereits gezeigter Ränge, werden nicht erneut produziert
CREATE INDEX IF NOT EXISTS idx_campaigns_probe ON campaigns(workspace_id, probe_state);
