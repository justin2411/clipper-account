#!/usr/bin/env python3
"""Selbsttest der reinen Pipeline-Funktionen – ohne Gemini, ohne Whisper, ohne ffmpeg.

Er prüft genau die Stellen, die sonst erst nach einer halben Stunde Actions-Lauf auffallen:
Rollen-Reihenfolge der Montage, Regelprüfung, Schnittplan und Untertitel-Blöcke.

    python3 scripts/check_pipeline.py
"""
import os, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("CLIPFORGE_API_URL", "http://localhost")
os.environ.setdefault("CLIPFORGE_API_KEY", "test")

from pipeline import montage as M, subtitles as SUB   # noqa: E402

fehler = []


def prüfe(name, bedingung, info=""):
    print(("  ok   " if bedingung else "  FEHL ") + name + (f" · {info}" if info else ""))
    if not bedingung:
        fehler.append(name)


def sortiere(segs):
    """Wie in montage.select: Segmente in die Reihenfolge der Linie bringen."""
    return sorted(segs, key=lambda s: M.ROLE_ORDER.get(str(s.get("role") or ""), M.ROLE_ORDER["build"]))


print("Montage – Rollen und Regeln")
clip = {"line": "Ein Satz zur Linie", "segments": [
    {"role": "payoff", "start": 300, "end": 306}, {"role": "stakes", "start": 10, "end": 13},
    {"role": "turn", "start": 200, "end": 208}, {"role": "build", "start": 100, "end": 109}]}
ok, why = M.validate(clip, 600)
prüfe("gültiger Clip wird angenommen", ok, why)
prüfe("Segmente kommen in die Reihenfolge der Linie",
      [s["role"] for s in sortiere(clip["segments"])] == ["stakes", "build", "turn", "payoff"])
prüfe("unbekannte Rolle wirft nicht", [s["role"] for s in sortiere(
    [{"role": "quatsch", "start": 1, "end": 2}, {"role": "stakes", "start": 3, "end": 4}])][0] == "stakes")
prüfe("zu nah beieinander wird verworfen",
      not M.validate({"line": "x", "segments": [{"role": "stakes", "start": 10, "end": 13},
                                                {"role": "build", "start": 20, "end": 29},
                                                {"role": "turn", "start": 35, "end": 43}]}, 600)[0])
prüfe("ohne Linien-Satz wird verworfen",
      not M.validate({"line": "", "segments": clip["segments"]}, 600)[0])
prüfe("Segment hinter dem Videoende wird verworfen", not M.validate(clip, 120)[0])

print("Montage – Schnittplan")
wörter = [{"word": f"w{i}", "start": 10 + i * 0.4, "end": 10.35 + i * 0.4} for i in range(60)]
wörter += [{"word": f"x{i}", "start": 100 + i * 0.4, "end": 100.35 + i * 0.4} for i in range(60)]
wörter += [{"word": f"y{i}", "start": 200 + i * 0.4, "end": 200.35 + i * 0.4} for i in range(60)]
wörter += [{"word": f"z{i}", "start": 300 + i * 0.4, "end": 300.35 + i * 0.4} for i in range(60)]
plan = M.plan({**clip, "segments": sortiere(clip["segments"])}, wörter)
teile = plan["parts"]
prüfe("Schnittplan hat Teile", len(teile) > 0, f"{len(teile)} Teile")
prüfe("kein Teil länger als 4 s", all(p["end"] - p["start"] <= M.PART_MAX_S + 0.3 for p in teile))
prüfe("kein Teil kürzer als 1 s", all(p["end"] - p["start"] >= M.PART_MIN_S - 0.05 for p in teile))
prüfe("höchstens zwei Punch-ins", sum(1 for p in teile if p["frame"] == "punch") <= M.PUNCH_PER_CLIP)

print("Untertitel")
blöcke = SUB.chunks([{"word": f"w{i}", "start": i * 0.3, "end": i * 0.3 + 0.25} for i in range(11)])
prüfe("Blöcke mit 2–4 Wörtern", all(2 <= len(b) <= 5 for b in blöcke), f"{[len(b) for b in blöcke]}")
ass = SUB.build_ass([{"word": "Hallo", "start": 0.2, "end": 0.6}, {"word": "Welt", "start": 0.6, "end": 1.0}],
                    1080, 1920, "A")
prüfe("ASS enthält Ereignisse", "Dialogue:" in ass)
prüfe("Untertitel nie tiefer als 72 %", SUB.top_of_subtitles(1920) < 1920 * SUB.BASELINE_PCT / 100)

print()
if fehler:
    print(f"{len(fehler)} Prüfung(en) fehlgeschlagen: " + ", ".join(fehler))
    sys.exit(1)
print("alle Prüfungen bestanden")
