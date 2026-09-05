#!/usr/bin/env bash
# Installiert den launchd-Job für die tägliche Vyro-Einreichung (21:30 lokale Zeit) auf dem Mac.
# Voraussetzungen: ~/.clipforge/env mit CLIPFORGE_API_URL und CLIPFORGE_API_KEY, `--login` und `--dry-run` erfolgreich.
#   ./scripts/install_vyro_launchd.sh            # installieren / aktualisieren
#   ./scripts/install_vyro_launchd.sh --remove   # entfernen
#   ./scripts/install_vyro_launchd.sh --now      # sofort einmal starten (Test)
set -euo pipefail
LABEL=com.clipforge.vyro-submit
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PY="$(command -v python3)"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.clipforge"
case "${1:-}" in
  --remove) launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "entfernt"; exit 0;;
  --now) launchctl kickstart -k "gui/$(id -u)/$LABEL"; echo "gestartet – Log: ~/.clipforge/vyro-submit.log"; exit 0;;
esac
[ -f "$HOME/.clipforge/env" ] || { echo "~/.clipforge/env fehlt (CLIPFORGE_API_URL=…, CLIPFORGE_API_KEY=…)"; exit 1; }
sed -e "s|__REPO__|$REPO|g" -e "s|__PYTHON__|$PY|g" -e "s|__HOME__|$HOME|g" "$REPO/scripts/launchd/$LABEL.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|program" | head -3
echo "installiert: täglich 21:30 → $PLIST (Log: ~/.clipforge/vyro-submit.log)"
