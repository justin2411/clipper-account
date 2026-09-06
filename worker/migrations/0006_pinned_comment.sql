-- Vorschlag für einen angepinnten Kommentar (Frage) je Clip, aus der Gemini-Momentwahl.
ALTER TABLE clips ADD COLUMN pinned_comment TEXT;
