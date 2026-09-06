-- Kleiner Key-Value-Speicher (nur über die authentifizierte API): z.B. yt_cookies – von yt-dlp nach jedem Job
-- aktualisierte YouTube-Cookies, damit die Sitzung ohne manuelles Erneuern frisch bleibt.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
