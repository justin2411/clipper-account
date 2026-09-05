# Nächste Schritte (in dieser Reihenfolge)

Stand 2026-09-05 – umgebaut auf Cloudflare (Workers + D1 + R2), Pipeline bleibt in GitHub Actions.

1. [x] Repo auf GitHub (public), Gerüst gepusht, Submodule `vendor/opensource-clipping` gepinnt (58b66a1).
2. [x] Cloudflare: API-Token + Account-ID in `.env` → `./scripts/cf_bootstrap.sh` (D1, R2, Migration `worker/migrations/0001_schema.sql`,
       Deploy, Worker-Secrets: CLIPFORGE_API_KEY, BLOTATO_API_KEY, TELEGRAM_*, GMAIL_*, GITHUB_TOKEN, ACCOUNTS_JSON).
       D1 `f699e8de…` angelegt, migriert; Worker live unter https://clipforge.clipforge-xy.workers.dev (2026-09-05). Cron läuft über `[triggers]` in `wrangler.toml`.
3. [x] Storage: R2-Bucket `clips` wird vom Bootstrap angelegt; öffentliche Auslieferung über den Worker (`/media/<key>`), kein Custom-Domain nötig.
4. [ ] Blotato Starter aktivieren, 2 TikTok-Accounts verbinden, IDs (`python scripts/run_fn.py accounts`) in `config/accounts.yaml` → `./scripts/cf_bootstrap.sh secrets`.
5. [ ] GitHub-Secrets setzen (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLIPFORGE_API_URL, CLIPFORGE_API_KEY, GOOGLE_API_KEY).
6. [ ] Erste Kampagne: `config/campaign_template.yaml` ausfüllen → `python scripts/set_footage.py <id> <drive_url> config/campaign_template.yaml` → `python scripts/run_fn.py scout`.
7. [ ] Erster Lauf mit `BLOTATO_DRAFT = "true"` (bereits gesetzt in `worker/wrangler.toml`) → Sichtprüfung der TikTok-Entwürfe → auf `"false"` → Push auf main deployt.
8. [ ] Nach der ersten echten Vyro-Mail: Absender/Betreff in `platforms/vyro.py` und `worker/src/scout.ts` kalibrieren.

Offen für V2: Telegram-Webhook für /footage und /submitted (Worker-Route), Dashboard (Cloudflare Pages auf D1-Views), Views-Quelle für den Tracker,
Audio-Peak-Scoring, eigener Clipper.
