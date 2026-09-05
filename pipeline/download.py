"""Footage holen. Rückgabe: Liste lokaler Videodateien (größte zuerst), leer wenn nichts geladen werden konnte.
  type=frameio  Share-Link (next.frame.io/share/<id>) – ohne Login, siehe pipeline/frameio.py
  type=gdrive   Google-Drive-Ordner oder -Datei mit Freigabe „Jeder mit dem Link“ (gdown)
  type=url      direkte Videodatei(en) (http…mp4, auch mehrere durch Leerzeichen/Komma getrennt) oder yt-dlp-URL"""
import re, subprocess, requests
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


def fetch(footage: dict, dest: Path) -> list[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    t, url = footage.get("type"), (footage.get("url") or "").strip()
    if not url:
        return []
    if t == "frameio" or "frame.io/" in url or re.match(r"https?://(www\.)?f\.io/", url):
        from pipeline.frameio import FrameioShare
        FrameioShare(url).download_all(dest)
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
