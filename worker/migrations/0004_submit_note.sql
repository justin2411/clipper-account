-- Ergebnis der automatischen Vyro-Einreichung (scripts/vyro_submit.py) je Post.
ALTER TABLE posts ADD COLUMN submit_note TEXT;
ALTER TABLE posts ADD COLUMN submit_attempts INTEGER NOT NULL DEFAULT 0;
