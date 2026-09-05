"""Footage holen. gdrive/url automatisch; frameio → None (manuell in Drive legen, dann type=gdrive)."""
import subprocess
from pathlib import Path


def fetch(footage: dict, dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    t, url = footage.get("type"), footage.get("url")
    if not url:
        return None
    if t == "gdrive":
        if "/folders/" in url:
            subprocess.run(["gdown", "--fuzzy", "--folder", url, "-O", str(dest)], check=True)
        else:  # einzelne Datei
            subprocess.run(["gdown", "--fuzzy", url, "-O", str(dest / "footage.mp4")], check=True)
    elif t == "url":
        subprocess.run(["yt-dlp", "-o", str(dest / "%(title)s.%(ext)s"), url], check=True)
    else:  # frameio / mediasilo: kein sauberer API-Download
        return None
    files = sorted([*dest.rglob("*.mp4"), *dest.rglob("*.mov"), *dest.rglob("*.mkv"), *dest.rglob("*.webm")],
                   key=lambda p: p.stat().st_size, reverse=True)
    return files[0] if files else None
