"""Transkript mit Wort-Zeitstempeln (faster-whisper). Grundlage für Montage, Schnitt auf Wortgrenzen und Untertitel.

Ergebnis: segments (Satzebene, für die Auswahl durch Gemini) und words (Wortebene, für Schnitt und Untertitel).
Das Modell kommt aus WHISPER_MODEL (Standard "small"); auf dem CI-Läufer läuft es auf der CPU mit int8.
"""
import json, os, subprocess
from pathlib import Path

import requests

from pipeline import progress as PG

MODEL = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
API = os.environ.get("CLIPFORGE_API_URL", "").rstrip("/")
KEY = os.environ.get("CLIPFORGE_API_KEY", "")


def duration(src: Path) -> float:
    """Spieldauer der Quelle – Bezugsgröße für den Prozentwert der Stufe „Transkript"."""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
                           capture_output=True, text=True)
        return float((r.stdout or "0").strip() or 0)
    except Exception:
        return 0.0


def _remote(campaign: str | None) -> str | None:
    """Zwischenspeicher im Bucket: ein wiederholter Lauf transkribiert nicht noch einmal zwanzig Minuten."""
    if not campaign or not API:
        return None
    return f"{API}/media/cache/{campaign}/transcript.json"


def transcribe(src: Path, out_dir: Path, language: str | None = "en", campaign: str | None = None) -> dict:
    """→ {"segments": [{start, end, text, words:[{word,start,end}]}], "words": [...], "text": "[s - e] text\\n…"}
    Das Ergebnis liegt in out_dir/transcript.json und – wenn eine Kampagne genannt ist – zusätzlich im Bucket,
    damit „Stufe wiederholen" nicht bei null anfängt."""
    out_dir.mkdir(parents=True, exist_ok=True)
    cache = out_dir / "transcript.json"
    if cache.is_file():
        try:
            return json.loads(cache.read_text())
        except Exception:
            pass
    url = _remote(campaign)
    if url:
        try:
            r = requests.get(url, timeout=60)
            if r.ok and r.content:
                data = r.json()
                if data.get("words"):
                    cache.write_text(json.dumps(data))
                    PG.tick(1.0, "aus dem Zwischenspeicher")
                    return data
        except Exception as e:
            print("transcript cache:", str(e)[:120])
    dur = duration(src)
    PG.tick(0.0, f"0 von {dur:.0f} s" if dur else None)
    from faster_whisper import WhisperModel
    model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE)
    segs, _info = model.transcribe(str(src), language=language, word_timestamps=True, vad_filter=True,
                                   vad_parameters={"min_silence_duration_ms": 400})
    segments, words = [], []
    for s in segs:
        if dur:                                                    # faster-whisper liefert die Segmente fortlaufend
            PG.update(min(1.0, float(s.end) / dur), f"{float(s.end):.0f} von {dur:.0f} s")
        ws = [{"word": (w.word or "").strip(), "start": round(float(w.start), 3), "end": round(float(w.end), 3)}
              for w in (s.words or []) if w.start is not None and w.end is not None and (w.word or "").strip()]
        segments.append({"start": round(float(s.start), 2), "end": round(float(s.end), 2), "text": (s.text or "").strip(), "words": ws})
        words += ws
    data = {"segments": segments, "words": words,
            "text": "\n".join(f"[{s['start']:.1f} - {s['end']:.1f}] {s['text']}" for s in segments if s["text"])}
    cache.write_text(json.dumps(data))
    if campaign and API and KEY:
        try:                                                       # in den Bucket, für Wiederholungen desselben Videos
            requests.put(f"{API}/api/media/cache/{campaign}/transcript.json", data=cache.read_bytes(), timeout=120,
                         headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}).raise_for_status()
        except Exception as e:
            print("transcript upload:", str(e)[:120])
    return data


def load(out_dir: Path) -> dict | None:
    p = out_dir / "transcript.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None
