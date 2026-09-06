"""Minimaler Client für die ClipForge-Worker-API (Cloudflare Worker + D1). Kein SDK nötig.
Env: CLIPFORGE_API_URL (https://clipforge.<subdomain>.workers.dev), CLIPFORGE_API_KEY."""
import os, requests

URL = os.environ["CLIPFORGE_API_URL"].rstrip("/")
H = {"Authorization": f"Bearer {os.environ['CLIPFORGE_API_KEY']}", "Content-Type": "application/json"}


def _req(method, path, **kw):
    r = requests.request(method, f"{URL}/api{path}", headers=H, timeout=60, **kw)
    if not r.ok:
        raise SystemExit(f"API {method} {path} → {r.status_code}: {r.text[:300]}")
    return r.json() if r.content else None


def get_campaign(cid):
    return _req("GET", f"/campaigns/{cid}")


def patch_campaign(cid, body):
    return _req("PATCH", f"/campaigns/{cid}", json=body)


def upsert_campaign(body):
    return _req("POST", "/campaigns", json=body)


def insert_clip(campaign_id, account, url, status, caption=None, note=None, hook_type=None, duration_s=None, hook=None, pinned_comment=None,
                video_id=None, rank=None, thumb_url=None, context_line=None, cover_url=None, scores=None, qa=None, variant=None):
    return _req("POST", "/clips", json={"campaign_id": campaign_id, "account": account, "media_url": url,
                                       "status": status, "caption": caption, "note": note, "hook_type": hook_type,
                                       "duration_s": duration_s, "hook": hook, "pinned_comment": pinned_comment,
                                       "video_id": video_id, "rank": rank, "thumb_url": thumb_url, "context_line": context_line,
                                       "cover_url": cover_url, "scores": scores, "qa": qa, "variant": variant})


def patch_video(video_id, **fields):
    """Status/Notiz eines YouTube-Videos im Katalog (schlägt nie hart fehl)."""
    try:
        return _req("PATCH", f"/videos/{video_id}", json=fields)
    except SystemExit as e:
        print("patch_video failed:", e); return None


def post_videos(items):
    return _req("POST", "/videos", json=items)


def notify_photo(path, caption):
    """Standbild + Text per Telegram (schlägt nie hart fehl)."""
    try:
        with open(path, "rb") as f:
            r = requests.post(f"{URL}/api/telegram/photo", headers={"Authorization": H["Authorization"]},
                              files={"photo": (os.path.basename(str(path)), f, "image/jpeg")}, data={"caption": caption}, timeout=60)
        return r.json() if r.content else None
    except Exception as e:
        print("notify_photo failed:", e); return None


def notify(text):
    """Info-Nachricht per Telegram (schlägt nie hart fehl)."""
    try:
        return _req("POST", "/telegram/send", json={"text": text})
    except SystemExit as e:
        print("notify failed:", e); return None


def log(campaign_id, event):
    return _req("POST", "/events", json={"campaign_id": campaign_id, "event": event})


def mark_submitted(cid):
    return _req("POST", f"/campaigns/{cid}/submitted")


def run(fn):
    return _req("POST", f"/run/{fn}")


def kv_get(key):
    """Wert aus dem Key-Value-Speicher (None, wenn nicht vorhanden)."""
    r = requests.get(f"{URL}/api/kv/{key}", headers=H, timeout=30)
    return r.json().get("value") if r.ok else None


def kv_put(key, value):
    r = requests.put(f"{URL}/api/kv/{key}", headers={"Authorization": H["Authorization"], "Content-Type": "text/plain; charset=utf-8"},
                     data=value.encode("utf-8"), timeout=60)
    r.raise_for_status()
    return r.json()


def patch_upload(upload_id, **fields):
    """Status eines Dashboard-Uploads (schlägt nie hart fehl)."""
    try:
        return _req("PATCH", f"/uploads/{upload_id}", json=fields)
    except SystemExit as e:
        print("patch_upload failed:", e); return None
