-- Budget-Pool je Kampagne (aus dem Vyro-Briefing / Kampagnenseite, manuell gepflegt) für das Dashboard.
ALTER TABLE campaigns ADD COLUMN budget_total_usd REAL;
ALTER TABLE campaigns ADD COLUMN budget_used_usd REAL;
