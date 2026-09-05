"""Cron-Funktion manuell starten: python scripts/run_fn.py scout|publisher|tracker|notify
Weitere: python scripts/run_fn.py health | overview | accounts (Blotato-Account-IDs)
         python scripts/run_fn.py dispatch <campaign_id> <account>   (Clip-Job nur für einen Account)"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import db  # noqa: E402

fn = sys.argv[1] if len(sys.argv) > 1 else "health"
if fn in ("health", "overview"):
    out = db._req("GET", f"/{fn}")
elif fn == "accounts":
    out = db._req("GET", "/blotato/accounts")
elif fn == "dispatch":
    out = db._req("POST", f"/dispatch/{sys.argv[2]}/{sys.argv[3]}")
else:
    out = db.run(fn)
print(json.dumps(out, indent=2, ensure_ascii=False))
