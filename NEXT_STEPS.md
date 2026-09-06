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
7. [x] Erster Lauf im Draft-Modus (6 Entwürfe, Sichtprüfung ok; Caption kommt bei TikTok-Entwürfen technisch nie mit) → privater Testpost mit voller Caption ok → `BLOTATO_DRAFT = "false"` seit 2026-09-05 20:28 UTC. Erste Live-Posts je Account sofort, Rest über Slots (`python scripts/run_fn.py publish_now <clip_id>` / `go_live`).
8. [ ] Nach der ersten echten Vyro-Mail: Absender/Betreff in `platforms/vyro.py` und `worker/src/scout.ts` kalibrieren.

Telegram (neuer Token, Chat-ID), Gmail (OAuth, Refresh-Token) und GitHub-Token sind im Worker gesetzt (`python scripts/run_fn.py health` zeigt alles true).

9. [x] Dashboard: `dashboard/index.html` auf Cloudflare Pages (https://clipforge-dashboard-bh8.pages.dev), Worker `GET /dashboard` mit `DASHBOARD_READ_KEY` (2026-09-05).

10. [~] Vyro-Einreichung automatisch: Worker-Endpunkte + `scripts/vyro_submit.py` fertig; auf dem Mac noch `--login`, `--probe`, `--dry-run`, dann `scripts/install_vyro_launchd.sh` (21:30).

Offen für V2: Views-Quelle für Tracker/Dashboard (Blotato liefert keine), Telegram-Webhook für /footage und /submitted, Audio-Peak-Scoring, eigener Clipper.

## Nachtrag (nach Dashboard-Stufe 7, noch nicht umsetzen)
Nächstes Arbeitspaket: Chat im Dashboard (#chat, Worker-Route POST /chat mit Konversations-ID, Verlauf in D1 je Workspace, Router
data/analysis/action → Haiku / starkes Modell / Aktionsvorschlag mit Bestätigung, lesende + handelnde Tools mit confirm-Token, Tagesbudget 1 $,
Wochenbericht sonntags 9 Uhr, täglicher Anomalie-Check) und sechs Features in dieser Reihenfolge:
Account-Gesundheit → Benachrichtigungszentrale (#inbox) → Chat (data/action) → Kalender (#calendar, move_slot) → Auszahlungen (#payouts, CSV) →
Clip-Bibliothek (#library) → Chat (analysis + Wochenbericht) → PWA. Jede Stufe deployen, Screenshot per Telegram, Datenvertrag in dashboard/index.html fortschreiben.
ANTHROPIC_API_KEY liegt bereits als Worker-Secret (nur im Worker, nie im Repo).

**Bauprinzip für alle Seiten (gilt ab sofort, auch für Stufen 2–7):** Progressive Disclosure in drei Tiefen. Tiefe 1 nur Kennzahl/Ampel/Aufgabe
(max. 5–7 Elemente pro Ebene), Tiefe 2 öffnet per Klick im selben Rahmen mit Zurück, Tiefe 3 (Clip-Details, Logs, Experten-Werte, Retention-Kurven)
nur auf ausdrücklichen Klick. Aufklappbares standardmäßig zu. Zahlen zuerst, Erklärung dahinter. Automatisch Erledigtes nicht anzeigen, nur
Entscheidungsbedarf. Der Chat folgt derselben Logik: kurze Antwort zuerst, „mehr" holt die Begründung.

## Vorschläge-Bereich (Nischen-Seite) – offen
RSS der Nischen-Kanäle + Backlog (yt-dlp-Playlist: Titel, Dauer, Aufrufe); Ranking neu (<30 Tage) zuerst, dann Backlog nach Aufrufen; verwendete
Videos und Videos unter der Mindestlänge der Nische ausschließen. Jeder Vorschlag mit Titel, Länge, Aufrufen, Alter, Begründung, Knopf „Nehmen"
→ Quelle mit needs_download. Automatik: Vorrat < „Vorrat in Tagen" (Regler, Standard 2) → oberster Vorschlag automatisch, sichtbar
„automatisch gewählt", abbrechbar; Telegram informiert nur.
