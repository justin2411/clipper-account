-- Lebenszeit-Werte je Account aus der TikTok-Profilseite (Follower, Likes gesamt, Videos) – Tages-Snapshot für +7d-Vergleiche.
ALTER TABLE account_stats ADD COLUMN likes_total INTEGER;
ALTER TABLE account_stats ADD COLUMN videos INTEGER;
