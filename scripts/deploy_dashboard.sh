#!/usr/bin/env bash
# Dashboard auf Cloudflare Pages deployen. Setzt den Lese-Key aus .env in die Seite ein (im Repo steht nur ein Platzhalter).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
[ -n "${DASHBOARD_READ_KEY:-}" ] || { echo "DASHBOARD_READ_KEY fehlt in .env"; exit 1; }
OUT=$(mktemp -d); sed "s|__DASHBOARD_READ_KEY__|$DASHBOARD_READ_KEY|" dashboard/index.html > "$OUT/index.html"
( cd worker && WRANGLER_SEND_METRICS=false npx wrangler pages deploy "$OUT" --project-name clipforge-dashboard --branch main --commit-dirty=true )
rm -rf "$OUT"
