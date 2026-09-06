"""Footage holen. Rückgabe: Liste lokaler Videodateien (größte zuerst), leer wenn nichts geladen werden konnte.
  type=frameio  Share-Link (next.frame.io/share/<id>) – ohne Login, siehe pipeline/frameio.py
  type=gdrive   Google-Drive-Ordner oder -Datei mit Freigabe „Jeder mit dem Link“ (gdown)
  type=url      direkte Videodatei(en) (http…mp4, auch mehrere durch Leerzeichen/Komma getrennt) oder yt-dlp-URL
  Fan-Footage: Upload über das Dashboard nach R2 → type=url auf /media/<key> (Worker). Kein YouTube-Download mehr."""
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


YT_FORMAT = "bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/bv*[vcodec^=avc1]+ba/bv*[height<=1080][ext=mp4]+ba/b[height<=1080]/b"


def _ensure_h264(dest: Path) -> None:
    """Quellen, die der Clipper nicht dekodieren kann (AV1/HEVC/VP9), nach H.264 transcodieren."""
    for p in _videos(dest):
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(p)],
                           capture_output=True, text=True)
        codec = r.stdout.strip()
        if codec and codec != "h264":
            print(f"[download] {p.name}: {codec} → H.264 transcodieren")
            tmp = p.with_name(p.stem + ".h264.mp4")
            subprocess.run(["ffmpeg", "-y", "-i", str(p), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(tmp)], check=True, capture_output=True)
            p.unlink(); tmp.rename(p)


def _ytdlp(url: str, dest: Path, fmt: str = YT_FORMAT) -> None:
    """Nur noch für explizite yt-dlp-URLs (type=url ohne Dateiendung). YouTube-Fan-Footage kommt per Dashboard-Upload (R2)."""
    r = subprocess.run(["yt-dlp", "-f", fmt, "--merge-output-format", "mp4", "--no-playlist", "-o", str(dest / "%(id)s.%(ext)s"), url], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"yt-dlp: {(r.stderr or r.stdout)[-400:]}")
    _ensure_h264(dest)


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
            if re.search(r"\.(mp4|mov|mkv|webm|m4v)(\?|$)", u, re.I) or "/media/" in u:
                _direct(u, dest)
            else:
                _ytdlp(u, dest)
        _ensure_h264(dest)                                # Uploads können HEVC/AV1 sein → H.264 für den Clipper
    return _videos(dest)
