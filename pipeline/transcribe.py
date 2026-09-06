"""Transkript mit Wort-Zeitstempeln (faster-whisper). Grundlage für Montage, Schnitt auf Wortgrenzen und Untertitel.

Ergebnis: segments (Satzebene, für die Auswahl durch Gemini) und words (Wortebene, für Schnitt und Untertitel).
Das Modell kommt aus WHISPER_MODEL (Standard "small"); auf dem CI-Läufer läuft es auf der CPU mit int8.
"""
import json, os
from pathlib import Path

MODEL = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")


def transcribe(src: Path, out_dir: Path, language: str | None = "en") -> dict:
    """→ {"segments": [{start, end, text, words:[{word,start,end}]}], "words": [...], "text": "[s - e] text\\n…"}
    Das Ergebnis wird in out_dir/transcript.json abgelegt und beim nächsten Lauf wiederverwendet."""
    out_dir.mkdir(parents=True, exist_ok=True)
    cache = out_dir / "transcript.json"
    if cache.is_file():
        try:
            return json.loads(cache.read_text())
        except Exception:
            pass
    from faster_whisper import WhisperModel
    model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE)
    segs, _info = model.transcribe(str(src), language=language, word_timestamps=True, vad_filter=True,
                                   vad_parameters={"min_silence_duration_ms": 400})
    segments, words = [], []
    for s in segs:
        ws = [{"word": (w.word or "").strip(), "start": round(float(w.start), 3), "end": round(float(w.end), 3)}
              for w in (s.words or []) if w.start is not None and w.end is not None and (w.word or "").strip()]
        segments.append({"start": round(float(s.start), 2), "end": round(float(s.end), 2), "text": (s.text or "").strip(), "words": ws})
        words += ws
    data = {"segments": segments, "words": words,
            "text": "\n".join(f"[{s['start']:.1f} - {s['end']:.1f}] {s['text']}" for s in segments if s["text"])}
    cache.write_text(json.dumps(data))
    return data


def load(out_dir: Path) -> dict | None:
    p = out_dir / "transcript.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None
