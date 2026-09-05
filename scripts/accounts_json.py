"""Erzeugt ACCOUNTS_JSON (Worker-Secret) aus config/accounts.yaml:
python scripts/accounts_json.py            → gibt JSON aus
python scripts/accounts_json.py | npx --prefix worker wrangler secret put ACCOUNTS_JSON --config worker/wrangler.toml"""
import json, sys, yaml
from pathlib import Path

cfg = yaml.safe_load((Path(__file__).resolve().parent.parent / "config/accounts.yaml").read_text())
out = {a["id"]: {"slots": a["slots_utc"], "blotato": {k: str(v) for k, v in (a.get("blotato") or {}).items() if v}} for a in cfg["accounts"]}
missing = [a for a, v in out.items() if not v["blotato"].get("tiktok")]
if missing:
    print(f"WARN: keine Blotato-TikTok-ID für {missing} – Publisher überspringt diese Accounts", file=sys.stderr)
print(json.dumps(out, separators=(",", ":")))
