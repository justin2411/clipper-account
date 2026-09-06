"""Footage holen. Rückgabe: Liste lokaler Videodateien (größte zuerst), leer wenn nichts geladen werden konnte.
  type=frameio  Share-Link (next.frame.io/share/<id>) – ohne Login, siehe pipeline/frameio.py
  type=gdrive   Google-Drive-Ordner oder -Datei mit Freigabe „Jeder mit dem Link“ (gdown)
  type=url      direkte Videodatei(en) (http…mp4, auch mehrere durch Leerzeichen/Komma getrennt) oder yt-dlp-URL
  type=youtube  YouTube-Video per yt-dlp (≤1080p, mp4). Optional YT_COOKIES_B64 (base64 cookies.txt) gegen Bot-Checks."""
import base64, os, re, subprocess, time, requests
from pathlib import Path

VIDEO_EXT = (".mp4", ".mov", ".mkv", ".webm", ".m4v")


def _videos(dest: Path) -> list[Path]:
    files = [p for p in dest.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_EXT and p.stat().st_size > 0]
    return sorted(files, key=lambda p: p.stat().st_size, reverse=True)


def _direct(url: str, dest: Path):
    name = re.sub(r"[^\w.\-]+", "_", url.split("?")[0].rsplit("/", 1)[-1] or "footage.mp4")
    if not name.lower().endswith(VIDEO_EXT):
        name += ".mp4"
    with requests.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        with open(dest / name, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)


COOKIE_KEY = "yt_cookies"


def _load_cookies(dest: Path) -> Path | None:
    """YouTube-Cookies: zuerst der von yt-dlp aktualisierte Stand aus D1 (kv yt_cookies), sonst Seed aus YT_COOKIES_B64.
    yt-dlp schreibt die Datei nach jedem Lauf mit erneuerten Cookies zurück → _save_cookies hält die Sitzung frisch."""
    text = ""
    try:
        from pipeline import db
        text = db.kv_get(COOKIE_KEY) or ""
    except Exception as e:
        print("[download] kv cookies nicht lesbar:", e)
    if not text.strip() and os.environ.get("YT_COOKIES_B64"):
        text = base64.b64decode(os.environ["YT_COOKIES_B64"]).decode("utf-8", "replace")
    if not text.strip():
        return None
    ck = dest / "cookies.txt"; ck.write_text(text, encoding="utf-8")
    return ck


def _save_cookies(ck: Path | None, before: str) -> None:
    if not ck or not ck.exists():
        return
    after = ck.read_text(encoding="utf-8", errors="replace")
    if after.strip() and after != before:
        try:
            from pipeline import db
            db.kv_put(COOKIE_KEY, after); print("[download] YouTube-Cookies aktualisiert gespeichert")
        except Exception as e:
            print("[download] kv cookies speichern fehlgeschlagen:", e)


def _ytdlp(url: str, dest: Path, fmt: str = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b") -> None:
    cmd = ["yt-dlp", "-f", fmt, "--merge-output-format", "mp4", "--no-playlist", "-o", str(dest / "%(id)s.%(ext)s"), url]
    ck = _load_cookies(dest)
    before = ck.read_text(encoding="utf-8") if ck else ""
    if ck:
        cmd[1:1] = ["--cookies", str(ck)]
    last = None
    try:
        for attempt, extra in enumerate(([], ["--extractor-args", "youtube:player_client=default,web_safari"]), 1):
            r = subprocess.run(cmd + extra, capture_output=True, text=True)
            if r.returncode == 0:
                return
            last = (r.stderr or r.stdout)[-400:]
            print(f"[download] yt-dlp Versuch {attempt} fehlgeschlagen: {last}")
            time.sleep(20)
    finally:
        _save_cookies(ck, before)
        if ck: ck.unlink(missing_ok=True)
    raise RuntimeError(f"yt-dlp: {last}" + (" (Cookies vorhanden, aber abgelaufen? → python scripts/yt_cookies.py <cookies.txt>)" if ck and last and "not a bot" in last else ""))


def fetch(footage: dict, dest: Path) -> list[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    t, url = footage.get("type"), (footage.get("url") or "").strip()
    if not url:
        return []
    if t == "frameio" or "frame.io/" in url or re.match(r"https?://(www\.)?f\.io/", url):
        from pipeline.frameio import FrameioShare
        FrameioShare(url).download_all(dest)
    elif t == "youtube" or re.search(r"(youtube\.com/watch|youtu\.be/)", url):
        _ytdlp(url, dest)
    elif t == "gdrive" or "drive.google.com" in url:
        if "/folders/" in url:
            subprocess.run(["gdown", "--folder", url, "-O", str(dest)], check=True)
        else:
            subprocess.run(["gdown", url, "-O", str(dest / "footage.mp4")], check=True)
    else:
        for u in re.split(r"[\s,]+", url):
            if not u:
                continue
            if re.search(r"\.(mp4|mov|mkv|webm|m4v)(\?|$)", u, re.I):
                _direct(u, dest)
            else:
                subprocess.run(["yt-dlp", "-o", str(dest / "%(title)s.%(ext)s"), u], check=True)
    return _videos(dest)
