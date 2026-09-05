# Nächste Schritte (in dieser Reihenfolge)

Stand 2026-09-05 – umgebaut auf Cloudflare (Workers + D1 + R2), Pipeline bleibt in GitHub Actions.

1. [x] Repo auf GitHub (public), Gerüst gepusht, Submodule `vendor/opensource-clipping` gepinnt (58b66a1).
2. [x] Cloudflare: API-Token + Account-ID in `.env` → `./scripts/cf_bootstrap.sh` (D1, R2, Migration `worker/migrations/0001_schema.sql`,
       Deploy, Worker-Secrets: CLIPFORGE_API_KEY, BLOTATO_API_KEY, TELEGRAM_*, GMAIL_*, GITHUB_TOKEN, ACCOUNTS_JSON).
       D1 `f699e8de…` angelegt, migriert; Worker live unter https://clipforge.clipforge-xy.workers.dev (2026-09-05). Cron läuft über `[triggers]` in `wrangler.toml`.
3. [x] Storage: R2-Bucket `clips` wird vom Bootstrap angelegt; öffentliche Auslieferung über den Worker (`/media/<key>`), kein Custom-Domain nötig.
4. [x] Blotato aktiv, API-Key im Worker. Beide TikTok-Accounts verbunden: A @mrbeastfire0 (58583), B @beastcrewclips (58594).
5. [x] GitHub-Secrets gesetzt (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLIPFORGE_API_URL, CLIPFORGE_API_KEY, GOOGLE_API_KEY) – deploy.yml auf main ist grün (Run #2).
6. [x] Erste Kampagne `mrbeast-book-challenge` angelegt (Vyro-Briefing bestätigt), Footage = Frame.io-Share. Allgemein: `config/campaign_template.yaml` ausfüllen → `python scripts/set_footage.py <id> <drive_url> config/campaign_template.yaml` → `python scripts/run_fn.py scout`.
7. [ ] Erster Lauf mit `BLOTATO_DRAFT = "true"` (bereits gesetzt in `worker/wrangler.toml`) → Sichtprüfung der TikTok-Entwürfe → auf `"false"` → Push auf main deployt.
8. [ ] Nach der ersten echten Vyro-Mail: Absender/Betreff in `platforms/vyro.py` und `worker/src/scout.ts` kalibrieren.

Telegram (neuer Token, Chat-ID), Gmail (OAuth, Refresh-Token) und GitHub-Token sind im Worker gesetzt (`python scripts/run_fn.py health` zeigt alles true).

Offen für V2: Telegram-Webhook für /footage und /submitted (Worker-Route), Dashboard (Cloudflare Pages auf D1-Views), Views-Quelle für den Tracker,
Audio-Peak-Scoring, eigener Clipper.
