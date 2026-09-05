"""Footage-Link setzen + Kampagne auf 'joined' (ersetzt in V1 den Telegram-Befehl /footage).
Legt die Kampagne an, falls sie noch nicht existiert (Felder aus der YAML-Vorlage).
python scripts/set_footage.py <campaign_id> <frameio_share|drive_url|video_url> [config/campaign_template.yaml]
Env: CLIPFORGE_API_URL, CLIPFORGE_API_KEY (z.B. via: set -a; source .env; set +a)"""
import sys, yaml
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import db  # noqa: E402

if len(sys.argv) < 3:
    raise SystemExit(__doc__)
cid, url = sys.argv[1], sys.argv[2]
ftype = "frameio" if ("frame.io/" in url or "://f.io/" in url) else "gdrive" if "drive.google.com" in url else "url"
body = {"footage": {"type": ftype, "url": url}, "status": "joined"}
if len(sys.argv) > 3:
    t = yaml.safe_load(open(sys.argv[3]))
    body.update({k: t[k] for k in ("platform", "name", "external_url", "rate_per_1k_usd", "min_views", "max_per_post_usd",
                                   "min_seconds", "required", "forbidden", "accounts", "platforms") if k in t})
if len(sys.argv) > 3 and "pool_paid_out_pct" in t:
    body["budget_used_usd"], body["budget_total_usd"] = float(t["pool_paid_out_pct"] or 0), 100   # Dashboard-Pool in Prozent ("% paid out" bei Vyro)
body["id"] = cid
if "platform" not in body or "name" not in body:
    existing = db.get_campaign(cid)  # bricht ab, wenn Kampagne unbekannt und keine Vorlage angegeben
    body.setdefault("platform", existing["platform"]); body.setdefault("name", existing["name"])
c = db.upsert_campaign(body)
print(f"ok: {c['id']} status={c['status']} footage={c['footage']} accounts={c['accounts']} platforms={c['platforms']}")
print("Scout startet die Clip-Jobs beim nächsten Lauf (≤10 min) – oder sofort: python scripts/run_fn.py scout")
