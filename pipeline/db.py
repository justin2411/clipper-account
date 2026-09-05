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


def insert_clip(campaign_id, account, url, status, caption=None, note=None, hook_type=None):
    return _req("POST", "/clips", json={"campaign_id": campaign_id, "account": account, "media_url": url,
                                       "status": status, "caption": caption, "note": note, "hook_type": hook_type})


def log(campaign_id, event):
    return _req("POST", "/events", json={"campaign_id": campaign_id, "event": event})


def mark_submitted(cid):
    return _req("POST", f"/campaigns/{cid}/submitted")


def run(fn):
    return _req("POST", f"/run/{fn}")
