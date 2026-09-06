# Mac-Helfer mit lokalem Cobalt

Der Helfer holt offene Download-Aufgaben aus dem Dashboard, lädt das Video über eine **lokal laufende
Cobalt-Instanz**, schiebt es direkt nach R2 und hakt die Aufgabe ab. Kein Railway, keine Cloud-Instanz,
keine laufenden Kosten. Cobalt hört nur auf `127.0.0.1:9000` und verlangt für jede Anfrage einen Schlüssel,
den die Einrichtung selbst erzeugt.

## Einrichtung

Voraussetzung ist Docker Desktop (einmal starten, dann läuft es im Hintergrund).

```bash
bash mac/install.sh
```

Das Skript fragt die Worker-URL und den ClipForge-API-Schlüssel ab und erledigt danach alles:

| Was | Wohin |
| --- | --- |
| Cobalt (Docker Compose) | `~/.clipforge/cobalt/` |
| Cobalt-Schlüssel (einmal erzeugt) | `~/.clipforge/cobalt/keys.json`, Rechte 600 |
| Zugangsdaten des Helfers | `~/.clipforge/env`, Rechte 600 |
| Helfer | `~/.clipforge/clipforge_helper.py` |
| Startet beim Anmelden | `~/Library/LaunchAgents/com.clipforge.cobalt.plist`, `…helper.plist` |
| Protokolle | `~/.clipforge/logs/` |

Keiner dieser Schlüssel liegt im Repository oder im Worker.

## Prüfen

```bash
python3 ~/.clipforge/clipforge_helper.py --once     # einmal durchlaufen, mit Ausgabe
tail -f ~/.clipforge/logs/helper.log               # laufender Dienst
cd ~/.clipforge/cobalt && docker compose ps         # läuft Cobalt?
```

## Was der Helfer tut

1. `GET /tasks` – offene Aufgaben der Art „footage" mit YouTube-Link.
2. `POST http://localhost:9000/` mit `videoQuality 1080`, `downloadMode auto`, `youtubeVideoCodec h264`,
   `youtubeVideoContainer mp4` – also die beste MP4-Spur bis 1080p mit Ton.
   Die Antwort kann vier Formen haben:
   - `tunnel` und `redirect`: eine URL, von dort wird geladen.
   - `picker`: eine Liste, der Helfer nimmt den ersten Video-Eintrag.
   - `local-processing`: Cobalt möchte lokal zusammenfügen. Das kann der Helfer nicht und meldet den Grund.
   - `error`: der Fehlercode geht als Telegram-Hinweis raus.
3. Größe prüfen: unter 5 MB gilt die Datei als kaputt, über `MAX_GB` (Standard 4 GB) bricht der Helfer ab.
4. `POST /sources/presign` → `PUT /sources/put/<id>?part=N` in Stücken zu 25 MB → `POST /sources/complete`
   mit der Aufgaben-Nummer. Damit startet der Clip-Job und die Aufgabe ist erledigt.

Fehlgeschlagene Aufgaben versucht der Helfer dreimal, danach lässt er sie liegen und meldet sich per Telegram.

## Einstellungen

In `~/.clipforge/env`:

| Schlüssel | Bedeutung | Standard |
| --- | --- | --- |
| `POLL_SECONDS` | Abstand zwischen zwei Durchläufen | 180 |
| `MAX_GB` | Obergrenze je Datei | 4 |
| `NICHE` | Nische, falls die Aufgabe keine nennt | mrbeast |

## Beenden

```bash
launchctl bootout gui/$UID/com.clipforge.helper
launchctl bootout gui/$UID/com.clipforge.cobalt
cd ~/.clipforge/cobalt && docker compose down
```
