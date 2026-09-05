#!/usr/bin/env bash
# Einmalige Cloudflare-Einrichtung (idempotent): D1 anlegen + ID eintragen, R2-Bucket, Migration, Deploy, Secrets.
# Voraussetzung: .env im Repo-Root (aus .env.example, Werte aus SECRETS.local.md) mit CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
#   ./scripts/cf_bootstrap.sh            # alles
#   ./scripts/cf_bootstrap.sh secrets    # nur Secrets aus .env neu setzen
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
export WRANGLER_SEND_METRICS=false
W="npx --prefix worker wrangler"
step="${1:-all}"

if [[ "$step" == "all" ]]; then
  cd worker; npm ci --no-audit --no-fund >/dev/null; cd ..
  if grep -q REPLACE_WITH_D1_ID worker/wrangler.toml; then
    echo "→ D1 anlegen"; ( cd worker && $W d1 create clipforge ) | tee /tmp/d1.out || true
    ID=$( (cd worker && $W d1 list --json) | python3 -c 'import json,sys; print(next(d["uuid"] for d in json.load(sys.stdin) if d["name"]=="clipforge"))')
    sed -i "s/REPLACE_WITH_D1_ID/$ID/" worker/wrangler.toml; echo "   database_id=$ID → worker/wrangler.toml (committen!)"
  fi
  echo "→ R2-Bucket"; ( cd worker && $W r2 bucket create clips ) 2>&1 | grep -viE "already exists" || true
  echo "→ Migration"; ( cd worker && $W d1 migrations apply clipforge --remote )
  echo "→ Deploy";    ( cd worker && $W deploy )
fi

echo "→ Secrets aus .env"
python3 - <<'PY' > /tmp/secrets.json
import json, os
keys = ["CLIPFORGE_API_KEY","BLOTATO_API_KEY","TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID","GMAIL_CLIENT_ID","GMAIL_CLIENT_SECRET","GMAIL_REFRESH_TOKEN","GITHUB_TOKEN"]
d = {k: os.environ[k] for k in keys if os.environ.get(k)}
import subprocess; d["ACCOUNTS_JSON"] = subprocess.check_output(["python3","scripts/accounts_json.py"], text=True).strip()
print(json.dumps(d)); print("gesetzt:", sorted(d), file=__import__("sys").stderr)
PY
( cd worker && $W secret bulk /tmp/secrets.json ); rm -f /tmp/secrets.json
echo "fertig. Test: python scripts/run_fn.py health"
