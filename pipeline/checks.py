"""Harte Prüfungen vor Upload. Alles, was hier scheitert, wird verworfen – nie repariert."""
import json, subprocess
from pathlib import Path


def probe(p: Path) -> dict:
    r = subprocess.run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", str(p)],
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def duration_of(p: Path) -> float | None:
    try:
        return round(float(probe(p)["format"]["duration"]), 1)
    except Exception:
        return None


def validate(p: Path, rules, forbidden: dict) -> tuple[bool, str]:
    info = probe(p)
    dur = float(info["format"]["duration"])
    if dur < rules.min_seconds:
        return False, f"too_short:{dur:.1f}s"
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if not v or int(v["height"]) < int(v["width"]):
        return False, "not_vertical"
    if int(v["height"]) < 1080:
        return False, "low_res"
    audio = [s for s in info["streams"] if s["codec_type"] == "audio"]
    if len(audio) != 1:
        return False, "audio_streams"
    return True, "ok"
