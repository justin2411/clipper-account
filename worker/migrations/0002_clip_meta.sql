-- Clip-Metadaten für Telegram-Meldungen: laufende Nummer je Kampagne, Länge, Hook-Satz.
ALTER TABLE clips ADD COLUMN seq INTEGER;          -- Nummer innerhalb der Kampagne (1..n)
ALTER TABLE clips ADD COLUMN duration_s REAL;      -- Länge in Sekunden
ALTER TABLE clips ADD COLUMN hook TEXT;            -- Hook-Satz / Titel aus dem Clipper
CREATE INDEX IF NOT EXISTS idx_clips_campaign_seq ON clips(campaign_id, seq);
