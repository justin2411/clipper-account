#!/usr/bin/env bash
# Einrichtung auf dem Mac in einem Befehl: lokale Cobalt-Instanz (Docker Compose) + ClipForge-Helfer,
# beide starten beim Anmelden. Kein Railway, keine Cloud, keine laufenden Kosten.
#
#   bash mac/install.sh                       (fragt die beiden ClipForge-Zugangsdaten ab)
#   CLIPFORGE_API_URL=… CLIPFORGE_API_KEY=… bash mac/install.sh    (ohne Rückfrage)
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$HOME/.clipforge"; COB="$DIR/cobalt"; AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$COB" "$DIR/logs" "$AGENTS"

command -v docker >/dev/null || { echo "Docker fehlt. Docker Desktop installieren: https://www.docker.com/products/docker-desktop/"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker läuft nicht. Docker Desktop starten und den Befehl erneut ausführen."; exit 1; }

# 1. Zugangsdaten (nur lokal, nie im Repository)
API_URL="${CLIPFORGE_API_URL:-}"; API_KEY="${CLIPFORGE_API_KEY:-}"
[ -f "$DIR/env" ] && . "$DIR/env" || true
API_URL="${API_URL:-${CLIPFORGE_API_URL:-}}"; API_KEY="${API_KEY:-${CLIPFORGE_API_KEY:-}}"
[ -n "$API_URL" ] || read -r -p "ClipForge-Worker-URL (z. B. https://clipforge.clipforge-xy.workers.dev): " API_URL
[ -n "$API_KEY" ] || read -r -s -p "ClipForge-API-Schlüssel: " API_KEY && echo

# 2. Cobalt-Schlüssel: einmal selbst erzeugen, danach unverändert lassen
KEYS="$COB/keys.json"
if [ -f "$KEYS" ]; then
  COBALT_KEY=$(python3 -c "import json;print(next(iter(json.load(open('$KEYS')))))")
else
  COBALT_KEY=$(python3 -c "import uuid;print(uuid.uuid4())")
  printf '{\n  "%s": { "name": "clipforge-helper", "limit": "unlimited" }\n}\n' "$COBALT_KEY" > "$KEYS"
  chmod 600 "$KEYS"
fi
cp "$SRC/docker-compose.yml" "$COB/docker-compose.yml"
cp "$SRC/clipforge_helper.py" "$DIR/clipforge_helper.py"; chmod +x "$DIR/clipforge_helper.py"

umask 077
cat > "$DIR/env" <<EOF
# ClipForge-Helfer – liegt nur auf diesem Mac, gehört nicht ins Repository.
CLIPFORGE_API_URL=$API_URL
CLIPFORGE_API_KEY=$API_KEY
COBALT_URL=http://localhost:9000/
COBALT_KEY=$COBALT_KEY
NICHE=mrbeast
POLL_SECONDS=180
MAX_GB=4
EOF
chmod 600 "$DIR/env"

# 3. Cobalt starten
( cd "$COB" && docker compose up -d --wait )
sleep 2
if curl -fsS -H "Authorization: Api-Key $COBALT_KEY" http://localhost:9000/ >/dev/null; then
  echo "Cobalt läuft auf http://localhost:9000/ (nur lokal erreichbar, Schlüssel verlangt)"
else
  echo "Cobalt antwortet noch nicht – 'cd ~/.clipforge/cobalt && docker compose logs' zeigt warum"
fi

# 4. Beide Dienste beim Anmelden starten
for L in com.clipforge.cobalt com.clipforge.helper; do
  sed "s|__HOME__|$HOME|g" "$SRC/$L.plist" > "$AGENTS/$L.plist"
  launchctl bootout "gui/$UID/$L" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$AGENTS/$L.plist"
done

echo
echo "Fertig."
echo "  Zugangsdaten:  $DIR/env        (Rechte 600, nur für dich lesbar)"
echo "  Cobalt:        $COB            docker compose ps | logs"
echo "  Helfer-Log:    $DIR/logs/helper.log"
echo "  Sofort prüfen: python3 $DIR/clipforge_helper.py --once"
echo "  Beenden:       launchctl bootout gui/$UID/com.clipforge.helper && launchctl bootout gui/$UID/com.clipforge.cobalt"
