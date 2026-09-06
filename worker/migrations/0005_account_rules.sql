-- Account-Regeln mit Ablauf: Pause bis Zeitpunkt, eigenes Tageslimit und Mindestabstand (Minuten) je Account.
ALTER TABLE account_state ADD COLUMN paused_until TEXT;      -- ISO; Pause endet automatisch
ALTER TABLE account_state ADD COLUMN max_per_day INTEGER;     -- NULL = globales MAX_CLIPS_PER_DAY
ALTER TABLE account_state ADD COLUMN min_gap_min INTEGER;     -- NULL = Slot-Plan wie er ist
ALTER TABLE account_state ADD COLUMN rules_until TEXT;        -- ISO; danach gelten wieder die globalen Regeln
