#!/usr/bin/env python3
"""ClipForge-Helfer für den Mac: offene Download-Aufgaben abholen, über die lokale Cobalt-Instanz laden,
direkt nach R2 hochladen und die Aufgabe als erledigt melden.

Ablauf je Aufgabe:
  1. GET  {API}/tasks                      → offene Aufgaben der Art „footage" mit YouTube-Link
  2. POST {COBALT}/                        → beste MP4-Spur bis 1080p mit Ton (h264, downloadMode auto)
     Antworttypen: tunnel und redirect liefern eine URL, picker liefert eine Liste (erstes Video),
     local-processing kann der Helfer nicht bedienen und meldet den Grund zurück.
  3. Datei laden, Größe prüfen (zu klein = kaputt, zu groß = Abbruch)
  4. POST {API}/sources/presign            → vorsignierte Upload-Adresse, dann PUT je Teilstück
  5. POST {API}/sources/complete           → Clip-Job startet, Aufgabe wird abgehakt („done")

Konfiguration in ~/.clipforge/env (schreibt das Installationsskript):
  CLIPFORGE_API_URL, CLIPFORGE_API_KEY, COBALT_URL, COBALT_KEY, optional NICHE, POLL_SECONDS, MAX_GB
Kein Schlüssel liegt im Repository, keiner im Worker.
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.request
from pathlib import Path

HOME = Path.home()
CFG_DIR = HOME / ".clipforge"
ENV_FILE = CFG_DIR / "env"
STATE_FILE = CFG_DIR / "state.json"
LOCK_FILE = CFG_DIR / "helper.lock"
PART = 25 * 1024 * 1024                      # der Worker nimmt Teilstücke bis 25 MB
MIN_BYTES = 5 * 1024 * 1024                  # alles darunter ist keine Videodatei
TIMEOUT = 120


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def load_env() -> dict:
    cfg = {}
    if ENV_FILE.is_file():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("CLIPFORGE_API_URL", "CLIPFORGE_API_KEY", "COBALT_URL", "COBALT_KEY", "NICHE", "POLL_SECONDS", "MAX_GB"):
        if os.environ.get(k):
            cfg[k] = os.environ[k]
    missing = [k for k in ("CLIPFORGE_API_URL", "CLIPFORGE_API_KEY", "COBALT_URL", "COBALT_KEY") if not cfg.get(k)]
    if missing:
        sys.exit(f"Fehlende Angaben in {ENV_FILE}: {', '.join(missing)}")
    cfg["CLIPFORGE_API_URL"] = cfg["CLIPFORGE_API_URL"].rstrip("/")
    cfg["COBALT_URL"] = cfg["COBALT_URL"].rstrip("/") + "/"
    return cfg


def req(url: str, method: str = "GET", data: bytes | None = None, headers: dict | None = None, timeout: int = TIMEOUT):
    r = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    return urllib.request.urlopen(r, timeout=timeout)


def api(cfg: dict, path: str, method: str = "GET", body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    h = {"x-api-key": cfg["CLIPFORGE_API_KEY"]}
    if data:
        h["Content-Type"] = "application/json"
    with req(cfg["CLIPFORGE_API_URL"] + path, method, data, h) as r:
        raw = r.read()
    return json.loads(raw or "{}")


# ---------- Cobalt ----------

def cobalt_source(cfg: dict, url: str) -> tuple[str, str]:
    """Beste MP4-Spur bis 1080p mit Ton. Rückgabe (Download-URL, Dateiname)."""
    body = json.dumps({
        "url": url,
        "videoQuality": "1080",
        "downloadMode": "auto",              # Video mit Ton
        "youtubeVideoCodec": "h264",         # h264 in mp4, direkt schnittfähig
        "youtubeVideoContainer": "mp4",
        "filenameStyle": "basic",
        "disableMetadata": True,
    }).encode()
    h = {"Accept": "application/json", "Content-Type": "application/json",
         "Authorization": f"Api-Key {cfg['COBALT_KEY']}", "User-Agent": "clipforge-helper/1.0"}
    try:
        with req(cfg["COBALT_URL"], "POST", body, h) as r:
            res = json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"Cobalt antwortet {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Cobalt nicht erreichbar ({e.reason}) – läuft der Docker-Dienst?")

    status = res.get("status")
    if status in ("tunnel", "redirect"):
        return res["url"], res.get("filename") or "footage.mp4"
    if status == "picker":
        videos = [p for p in res.get("picker") or [] if p.get("type") == "video" and p.get("url")]
        if not videos:
            raise RuntimeError("Cobalt lieferte eine Auswahl ohne Video")
        return videos[0]["url"], res.get("audioFilename") or "footage.mp4"
    if status == "local-processing":
        raise RuntimeError(f"Cobalt möchte lokal zusammenfügen ({res.get('type')}) – das kann der Helfer nicht, "
                           f"bitte die Qualität senken oder das Video von Hand laden")
    if status == "error":
        raise RuntimeError(f"Cobalt-Fehler: {(res.get('error') or {}).get('code', 'unbekannt')}")
    raise RuntimeError(f"unbekannte Cobalt-Antwort: {str(res)[:160]}")


def download(url: str, dest: Path, max_bytes: int) -> int:
    """Datei laden und dabei die Größe prüfen. Rückgabe: Bytes."""
    h = {"User-Agent": "clipforge-helper/1.0"}
    total = 0
    with req(url, "GET", None, h, timeout=1800) as r, dest.open("wb") as f:
        declared = int(r.headers.get("Content-Length") or 0)
        if declared and declared > max_bytes:
            raise RuntimeError(f"Datei zu groß: {declared / 1e9:.1f} GB")
        while True:
            chunk = r.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise RuntimeError(f"Abbruch bei {total / 1e9:.1f} GB (Obergrenze {max_bytes / 1e9:.1f} GB)")
            f.write(chunk)
    if total < MIN_BYTES:
        raise RuntimeError(f"Datei ist nur {total / 1e6:.1f} MB groß – das ist kein vollständiges Video")
    return total


# ---------- Upload nach R2 ----------

def upload(cfg: dict, path: Path, niche: str, video_id: str, title: str, task_id: str) -> dict:
    size = path.stat().st_size
    pre = api(cfg, "/sources/presign", "POST", {"niche": niche, "name": f"{title[:60] or video_id}.mp4",
                                                "size": size, "type": "fan", "video_id": video_id})
    if "source_id" not in pre:
        raise RuntimeError(f"presign fehlgeschlagen: {str(pre)[:160]}")
    part_size = int(pre.get("part_size") or PART)
    with path.open("rb") as f:
        n = 0
        while True:
            chunk = f.read(part_size)
            if not chunk:
                break
            n += 1
            with req(f"{pre['upload_url']}?part={n}", "PUT", chunk,
                     {"x-api-key": cfg["CLIPFORGE_API_KEY"], "Content-Type": "application/octet-stream"}, timeout=900) as r:
                r.read()
            log(f"    Teil {n} hochgeladen ({len(chunk) / 1e6:.0f} MB)")
    return api(cfg, "/sources/complete", "POST", {"source_id": pre["source_id"], "task_id": task_id})


# ---------- Aufgaben ----------

YT = re.compile(r"(?:youtube\.com/watch\?v=|youtu\.be/)([\w-]{6,})")


def open_tasks(cfg: dict) -> list[dict]:
    data = api(cfg, "/tasks")
    items = data.get("items") if isinstance(data, dict) else data
    out = []
    for t in items or []:
        if t.get("done") or t.get("kind") != "footage":
            continue
        urls = t.get("urls") or []
        url = next((u for u in urls if YT.search(str(u))), None)
        if not url:
            continue
        out.append({"id": t.get("id"), "title": t.get("title") or "", "niche": t.get("niche") or "",
                    "url": url, "video_id": YT.search(url).group(1)})
    return out


def state() -> dict:
    try: return json.loads(STATE_FILE.read_text())
    except Exception: return {}


def save_state(s: dict) -> None:
    CFG_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(s, indent=1))


def handle(cfg: dict, task: dict) -> bool:
    max_bytes = int(float(cfg.get("MAX_GB", 4)) * 1e9)
    niche = task["niche"] or cfg.get("NICHE") or "mrbeast"
    tmp = CFG_DIR / "tmp"; tmp.mkdir(parents=True, exist_ok=True)
    dest = tmp / f"{task['video_id']}.mp4"
    log(f"  Aufgabe {task['id']}: {task['title'][:70]}")
    try:
        src, name = cobalt_source(cfg, task["url"])
        log(f"    Cobalt liefert {name}")
        size = download(src, dest, max_bytes)
        log(f"    geladen: {size / 1e6:.0f} MB")
        r = upload(cfg, dest, niche, task["video_id"], task["title"].split(":")[-1].strip(), task["id"])
        log(f"    fertig: {json.dumps(r)[:160]}")
        return True
    except Exception as e:
        log(f"    FEHLER: {e}")
        try: api(cfg, "/notify", "POST", {"text": f"⚠️ Mac-Helfer: {task['title'][:60]} – {str(e)[:160]}"})
        except Exception: pass
        return False
    finally:
        dest.unlink(missing_ok=True)


def once(cfg: dict) -> int:
    st = state()
    done = set(st.get("done") or [])
    failed = st.get("failed") or {}
    tasks = open_tasks(cfg)
    log(f"{len(tasks)} offene Download-Aufgabe(n)")
    n = 0
    for t in tasks:
        if t["id"] in done or failed.get(t["id"], 0) >= 3:
            continue
        if handle(cfg, t):
            done.add(t["id"]); n += 1
        else:
            failed[t["id"]] = failed.get(t["id"], 0) + 1
        st["done"], st["failed"] = sorted(done)[-200:], failed
        save_state(st)
    return n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--loop", action="store_true", help="dauerhaft laufen (für den Anmelde-Dienst)")
    ap.add_argument("--once", action="store_true", help="einmal prüfen und beenden")
    a = ap.parse_args()
    cfg = load_env()
    CFG_DIR.mkdir(parents=True, exist_ok=True)
    if not a.loop:
        once(cfg); return
    wait = int(cfg.get("POLL_SECONDS", 180))
    log(f"Helfer läuft, prüft alle {wait} s ({cfg['CLIPFORGE_API_URL']}, Cobalt {cfg['COBALT_URL']})")
    while True:
        try:
            once(cfg)
        except Exception as e:
            log(f"Durchlauf fehlgeschlagen: {e}")
        time.sleep(wait)


if __name__ == "__main__":
    main()
