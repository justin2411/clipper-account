"""Cron-Funktion manuell starten: python scripts/run_fn.py scout|publisher|tracker|notify
Weitere: python scripts/run_fn.py health | overview | accounts (Blotato-Account-IDs)
         python scripts/run_fn.py dispatch <campaign_id> <account>   (Clip-Job nur für einen Account)
         python scripts/run_fn.py go_live   (nach der Sichtprüfung: Entwurfs-Clips wieder auf 'ready')
         python scripts/run_fn.py publish_now <clip_id>   (einen 'ready'-Clip sofort posten)
         python scripts/run_fn.py publish_campaign <campaign_id> [gap_min]   (alle 'ready'-Clips zeitversetzt, nie gleichzeitig)
         python scripts/run_fn.py account <A|B> '<json>'   (Regeln: paused, paused_until, max_per_day, min_gap_min, rules_until)
Fan-Content / Schattenmodus:
         python scripts/run_fn.py fan                 (RSS prüfen + Backlog nachfüllen)
         python scripts/run_fn.py fanjob <videoId>    (Fan-Kampagne + Clip-Job AB für ein Video)
         python scripts/run_fn.py videos [status]     (Katalog)
         python scripts/run_fn.py plan [hours]        (geplante Posts live/shadow)
         python scripts/run_fn.py daily | weekly      (Tagesübersicht / Wochenreport jetzt senden)
         python scripts/run_fn.py shadow_release      (Schatten-Posts archivieren, Clips wieder 'ready' – dann PUBLISH_MODE=live deployen)"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import db  # noqa: E402

fn = sys.argv[1] if len(sys.argv) > 1 else "health"
if fn in ("health", "overview"):
    out = db._req("GET", f"/{fn}")
elif fn == "accounts":
    out = db._req("GET", "/blotato/accounts")
elif fn == "publish_now":
    out = db._req("POST", f"/publish_now/{sys.argv[2]}")
elif fn == "publish_campaign":   # zeitversetzt: erster je Account sofort, weitere alle <gap> Minuten (Standard 45)
    gap = sys.argv[3] if len(sys.argv) > 3 else "45"
    out = db._req("POST", f"/publish_campaign/{sys.argv[2]}?gap={gap}")
elif fn == "account":   # python scripts/run_fn.py account B '{"paused":1,"paused_until":"2026-09-06T04:00:00Z","max_per_day":2,"min_gap_min":240,"rules_until":"2026-09-13T04:00:00Z"}'
    out = db._req("PATCH", f"/accounts/{sys.argv[2]}", json=json.loads(sys.argv[3]))
elif fn == "accounts_state":
    out = db._req("GET", "/accounts")
elif fn == "go_live":
    out = db._req("POST", "/go_live")
elif fn == "dispatch":
    out = db._req("POST", f"/dispatch/{sys.argv[2]}/{sys.argv[3]}")
elif fn == "fanjob":
    out = db._req("POST", f"/fan/{sys.argv[2]}")
elif fn == "videos":
    st = f"?status={sys.argv[2]}" if len(sys.argv) > 2 else ""
    out = db._req("GET", f"/videos{st}")
elif fn == "plan":
    out = db._req("GET", f"/plan?hours={sys.argv[2] if len(sys.argv) > 2 else 24}")
elif fn == "shadow_release":
    out = db._req("POST", "/shadow_release")
else:
    out = db.run(fn)
print(json.dumps(out, indent=2, ensure_ascii=False))
