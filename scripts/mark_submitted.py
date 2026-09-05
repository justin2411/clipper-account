"""Nach dem Einreichen bei Vyro: python scripts/mark_submitted.py <campaign_id>
Markiert alle geposteten/geplanten Clips der Kampagne als eingereicht; der Tracker löscht die Dateien dann aus R2."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import db  # noqa: E402

r = db.mark_submitted(sys.argv[1])
print(f"{r['marked']} clips markiert")
