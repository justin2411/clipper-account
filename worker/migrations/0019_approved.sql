-- Abnahme festhalten: ein Clip, den du freigegeben hast, ist erledigt und gehört nicht mehr in die Clip-Vorschau.
-- Bisher blieben schon eingeplante Clips dort für immer stehen, weil „Freigeben" an ihnen nichts mehr ändern konnte.
ALTER TABLE clips ADD COLUMN approved_at TEXT;
