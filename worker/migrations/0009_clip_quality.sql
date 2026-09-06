-- Clip-Qualität: Kontextzeile (Originalität), Cover-Frame, Bewertung der Momentwahl, QA-Ergebnis, Lern-Variante.
ALTER TABLE clips ADD COLUMN context_line TEXT;   -- eigene Worte, ≤8 Wörter: Hook-Text im Bild + erster Caption-Satz
ALTER TABLE clips ADD COLUMN cover_url TEXT;      -- Cover-Frame (JPEG in R2); Video beginnt mit diesem Frame → Blotato videoCoverTimestamp=0
ALTER TABLE clips ADD COLUMN scores TEXT;         -- JSON der Momentbewertung (surprise, stakes, reaction, cliffhanger, standalone, clarity, total)
ALTER TABLE clips ADD COLUMN qa TEXT;             -- JSON der automatischen QA (hook_legible, no_text_overlap, face_in_frame, not_blurry, safe_zone_ok)
ALTER TABLE clips ADD COLUMN variant TEXT;        -- Lernschleife: Variante der Woche (z.B. hook_style=question)
