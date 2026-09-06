"""YouTube-Cookies einmalig hinterlegen (danach hält die Pipeline sie selbst frisch – yt-dlp erneuert sie bei jedem Lauf,
pipeline/download.py speichert den Stand in D1):
  python scripts/yt_cookies.py ~/Downloads/cookies.txt      (Netscape-Format, z.B. Erweiterung „Get cookies.txt LOCALLY“)
  python scripts/yt_cookies.py --status                     (wann zuletzt aktualisiert)
Env: CLIPFORGE_API_URL/KEY. Tipp: Zweitkonto verwenden, nicht das Hauptkonto."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import requests  # noqa: E402
from pipeline import db  # noqa: E402

if len(sys.argv) < 2 or sys.argv[1] == "--status":
    r = requests.get(f"{db.URL}/api/kv/yt_cookies", headers=db.H, timeout=30)
    d = r.json() if r.ok else {}
    v = d.get("value") or ""
    print(f"yt_cookies: {len(v)} Bytes, {sum(1 for l in v.splitlines() if l and not l.startswith('#'))} Cookies, aktualisiert {d.get('updated_at', '–')}" if v else "yt_cookies: nicht gesetzt")
    sys.exit(0)
text = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
lines = [l for l in text.splitlines() if l and not l.startswith("#")]
yt = [l for l in lines if "youtube.com" in l or "google.com" in l]
if not yt:
    sys.exit("Keine youtube.com/google.com-Cookies in der Datei – Export auf youtube.com wiederholen.")
if not text.startswith("# Netscape") and not text.startswith("# HTTP Cookie File"):
    text = "# Netscape HTTP Cookie File\n" + text
print(db.kv_put("yt_cookies", text), f"({len(yt)} YouTube/Google-Cookies)")
print("Fertig. Nächster Fan-Job nutzt die Cookies: python scripts/run_fn.py fan")
