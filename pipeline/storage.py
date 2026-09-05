"""Upload nach Cloudflare R2 über die Worker-API (PUT /api/media/<key>). Der Worker liefert die Datei
öffentlich unter /media/<key> aus; der Tracker löscht sie nach Einreichung."""
import os, requests
from pathlib import Path

URL = os.environ["CLIPFORGE_API_URL"].rstrip("/")
KEY = os.environ["CLIPFORGE_API_KEY"]


def upload(p: Path, prefix: str) -> str:
    key = f"{prefix}/{p.name}"
    with open(p, "rb") as f:
        r = requests.put(f"{URL}/api/media/{key}", data=f, timeout=600,
                         headers={"Authorization": f"Bearer {KEY}", "Content-Type": "video/mp4"})
    r.raise_for_status()
    return r.json()["url"]
