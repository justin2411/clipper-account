# ClipForge – automatisiertes Clipping-System (Vyro + TikTok zuerst, plattformoffen)

**Phase 1: nur TikTok, 2 Accounts.** Instagram/YouTube später über `platforms:` in der Kampagne aktivieren.

Pipeline: **Kampagne erkennen → Footage → Clips schneiden → prüfen → posten (Blotato) → tracken → Regeln anwenden**.
Menschliche Schritte (bewusst, wegen Plattformregeln): Kampagne beitreten, Footage-Link setzen, Post-Links einreichen.
Footage lädt die Pipeline selbst: Frame.io-Share (ohne Login, `pipeline/frameio.py`), Google-Drive-Ordner/-Datei („Jeder mit dem Link“) oder direkte Video-URLs; mehrere Dateien werden nacheinander geschnitten.

## Architektur
- `platforms/` – Adapter pro Clipping-Plattform (`vyro.py` fertig, `whop.py` Stub). Neue Plattform = eine Datei.
- `pipeline/` – Python: Download, Schnitt (opensource-clipping), Overlay, Caption, Checks, Upload. Läuft in GitHub Actions.
- `worker/` – **Cloudflare Worker** (ersetzt Supabase): D1 = Datenbank, R2 = Clip-Storage, Cron-Trigger = Scout/Publisher/Tracker/Notify,
  HTTP-API für Pipeline und Scripts, öffentliche Clip-Auslieferung unter `/media/<key>` (für Blotato). Läuft 24/7 im Free-Tier, keine Pausen.
- `config/` – Alles, was sich ändert (Accounts, Kampagnen-Vorlagen, Regeln). Kein Wert im Code.
- `.github/workflows/` – `clip.yml` (schwerer Schnitt-Job, per `workflow_dispatch` vom Scout gestartet), `deploy.yml` (Worker-Deploy bei Push auf `main`).
- `dashboard/` – statisches Dashboard (Cloudflare Pages: https://clipforge-dashboard-bh8.pages.dev), liest `GET /dashboard` vom Worker mit dem Lese-Key `DASHBOARD_READ_KEY`. Kein Login: Worker-URL und Lese-Key stehen in der Seite (im Repo als Platzhalter). Deploy: `./scripts/deploy_dashboard.sh`.
- `vendor/opensource-clipping` – gepinntes Submodule (Clipper).

## Setup (einmalig)
1. **Cloudflare**: Account, API-Token (Vorlage „Edit Cloudflare Workers“ + D1:Edit + R2:Edit), Account-ID → `.env` (aus `.env.example`).
   `./scripts/cf_bootstrap.sh` legt D1 + R2 an, trägt die D1-ID in `worker/wrangler.toml` ein, migriert, deployt und setzt die Worker-Secrets aus `.env`.
2. **GitHub-Secrets** (Repo → Settings → Secrets → Actions): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLIPFORGE_API_URL`, `CLIPFORGE_API_KEY`, `GOOGLE_API_KEY`.
3. **Blotato**: Starter aktivieren, 2 TikTok-Accounts verbinden, API-Key erzeugen → `.env`. IDs: `python scripts/run_fn.py accounts` → `config/accounts.yaml` → `./scripts/cf_bootstrap.sh secrets`.
4. **Telegram**: Bot @clipforge_xy_bot anschreiben (`/start`), Chat-ID aus `https://api.telegram.org/bot<TOKEN>/getUpdates` → `.env`.
5. **Gmail-API**: OAuth-Client (Desktop) in der Google Cloud Console, `client_secret.json` lokal, `python scripts/gmail_auth.py` → Refresh-Token → `.env`.
6. **GitHub-Token** (fine-grained, nur dieses Repo, Actions: Read and write) → `.env` (der Worker startet damit `clip.yml`).
7. **Vyro**: Social-Accounts verknüpfen, E-Mail-Benachrichtigungen an.

Alle Secrets stehen lokal in `SECRETS.local.md` (gitignored). Nach jeder Änderung an `.env`: `./scripts/cf_bootstrap.sh secrets`.

## Täglicher Ablauf (automatisch)
| Schritt | Wo | Auslöser |
|---|---|---|
| Scout liest Vyro-Mails, legt Kampagne an, Telegram | Worker `scout` | Cron 10 min |
| Du: Join + Footage-Link setzen (`scripts/set_footage.py`) | Mensch | – |
| Clip-Job startet (je Account) | GitHub Actions `clip.yml` | Worker `scout` via workflow_dispatch |
| Clips → R2, Zeilen in `clips` | Pipeline | Job-Ende |
| Publisher schedult Slots bei Blotato (`BLOTATO_DRAFT=true` → TikTok-Entwürfe) | Worker `publisher` | Cron 30 min |
| 21:00 Telegram mit Post-URLs zum Einreichen | Worker `notify` | Cron täglich |
| Tracker zieht Post-Status/URLs, meldet jeden Live-Post per Telegram, prüft Kill-Switch, löscht eingereichte Clips aus R2 | Worker `tracker` | Cron 6 h |

## Bedienung
```bash
set -a; source .env; set +a                       # CLIPFORGE_API_URL / _KEY laden
python scripts/run_fn.py health                   # was ist konfiguriert?
python scripts/set_footage.py <id> <drive_url> config/campaign_template.yaml   # Kampagne anlegen/joinen + Footage
python scripts/run_fn.py scout                    # Clip-Jobs sofort starten (statt auf Cron zu warten)
python scripts/run_fn.py publisher|tracker|notify # Funktionen manuell auslösen
python scripts/run_fn.py overview                 # Status aller Tabellen
python scripts/run_fn.py publish_campaign <id> [gap]  # alle fertigen Clips zeitversetzt (erster je Account sofort, dann alle 45 min)
python scripts/mark_submitted.py <id>             # nach dem Einreichen bei Vyro
```
Lokal entwickeln: `cd worker && npm ci && npm run migrate:local && npm run dev` (Secrets in `worker/.dev.vars`, Vorlage `.dev.vars.example`).

## Hinweise
- **Blotato liefert keine Views.** `views_*` in `posts` bleiben leer, bis eine Quelle angebunden ist (V2). Der Views-Kill-Switch greift erst dann; der Ablehnungs-Kill-Switch (Spam/Automation) funktioniert sofort.
- Cron-Zeiten sind UTC (`worker/wrangler.toml`); Slots in `config/accounts.yaml` ebenfalls (4 Slots/Account/Tag, 22:30 als letzter).
- Telegram informiert nur (Kampagne angelegt, Clip-Job fertig, Post live, Einreichliste, Kill-Switch); es gibt keine Freigabe-Schleife.
- Kampagnen-Budget für das Dashboard: `campaigns.budget_total_usd` / `budget_used_usd` manuell pflegen (`PATCH /api/campaigns/:id`).

## Vyro-Einreichung automatisch (Mac)
`scripts/vyro_submit.py` reicht Post-URLs per Browser bei Vyro ein (kein Vyro-API). Läuft lokal auf dem Mac mit gespeichertem Login-Profil.
```bash
pip install playwright requests && playwright install chromium
printf 'CLIPFORGE_API_URL=https://clipforge.clipforge-xy.workers.dev\nCLIPFORGE_API_KEY=…\n' > ~/.clipforge/env
set -a; source ~/.clipforge/env; set +a
python scripts/vyro_submit.py --check-api   # Worker erreichbar, offene Posts
python scripts/vyro_submit.py --login       # einmalig: Browser öffnet sich, bei Vyro einloggen, Fenster schließen
python scripts/vyro_submit.py --probe       # Buttons/Felder des Submit-Dialogs auflisten → scripts/vyro_selectors.json abgleichen
python scripts/vyro_submit.py --dry-run     # alles bis zum Submit-Klick, Screenshots in ~/.clipforge/vyro-shots
./scripts/install_vyro_launchd.sh           # erst nach erfolgreichem Dry-Run: täglich 21:30 lokal (launchd)
```
Worker-Endpunkte dafür (`x-api-key`): `GET /submissions/pending`, `POST /submissions/mark`, `POST /notify`. Nach 3 Fehlversuchen bleibt ein Post draußen (`posts.submit_attempts`), Telegram meldet Zusammenfassung und Stopps.

## Neue Plattform anbinden
`platforms/base.py` implementieren: `parse_email()`, `campaign_rules()`, `caption()`, `submission_hint()`. Absender-Domain zusätzlich in `worker/src/scout.ts` (`SENDERS`) eintragen.
