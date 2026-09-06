"""Untertitel aus dem Whisper-Transkript mit Wort-Zeitstempeln (ASS, von ffmpeg eingebrannt).

Immer an, außer es wird nicht gesprochen (Musik, keine Wörter im Clip).
  • 2–4 Wörter gleichzeitig, das gerade gesprochene Wort in der Akzentfarbe des Accounts
  • Grundlinie bei 72 % der Höhe, nie tiefer (darunter liegen TikToks Bedienelemente)
  • Breite 84 %, mittig, höchstens 2 Zeilen
  • Gestaltung aus dem Account-Design: A weiß mit orangem Akzent (Anton), B gelb mit lila Akzent (Bangers)
  • keine farbige Box, schwarze Kontur 5 px, weicher Schatten

Die Umsetzung nutzt ein ASS-Ereignis je Wortschritt: derselbe Wortblock, jeweils ein Wort eingefärbt.
Das ist genauer als Karaoke-Tags, weil die Wortdauern direkt aus Whisper kommen.
"""
from pathlib import Path

BASELINE_PCT = 72.0            # Grundlinie: nie tiefer als 72 % der Höhe
WIDTH_PCT = 84.0
MAX_LINES = 2
CHUNK_MIN, CHUNK_MAX = 2, 4    # Wörter gleichzeitig
OUTLINE_PX = 5
GAP_S = 0.7                    # längere Sprechpause → neuer Block

STYLES = {                     # Account-Design (config/brand.yaml); Fallback = A
    "A": {"font": "Anton", "color": "#FFFFFF", "accent": "#FF6A00"},
    "B": {"font": "Bangers", "color": "#FFD400", "accent": "#7B2FF7"},
}


def _ass_color(hex_color: str, alpha: int = 0) -> str:
    """#RRGGBB → &HAABBGGRR (ASS dreht die Reihenfolge um)."""
    h = (hex_color or "#FFFFFF").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b.upper()}{g.upper()}{r.upper()}"


def _t(sec: float) -> str:
    sec = max(0.0, float(sec))
    h = int(sec // 3600); m = int((sec % 3600) // 60); s = sec % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def chunks(words: list[dict], size_min: int = CHUNK_MIN, size_max: int = CHUNK_MAX, gap: float = GAP_S) -> list[list[dict]]:
    """Wörter zu Blöcken von 2–4 gruppieren; eine Sprechpause oder ein Satzende beginnt einen neuen Block."""
    out: list[list[dict]] = []
    cur: list[dict] = []
    for i, w in enumerate(words):
        if cur:
            pause = float(w["start"]) - float(cur[-1]["end"])
            ende = str(cur[-1].get("word", "")).strip().endswith((".", "!", "?"))
            if pause > gap or ende or len(cur) >= size_max:
                out.append(cur); cur = []
        cur.append(w)
        if len(cur) >= size_max and i + 1 < len(words):
            out.append(cur); cur = []
    if cur:
        if out and len(cur) < size_min:            # einzelnes Restwort an den letzten Block hängen
            out[-1].extend(cur)
        else:
            out.append(cur)
    return out


def build_ass(words: list[dict], width: int, height: int, account: str = "A", style: dict | None = None,
              baseline_pct: float = BASELINE_PCT, offset: float = 0.0, duration: float | None = None) -> str:
    """ASS-Datei als Text. `words` sind Wörter mit start/end in Sekunden der fertigen Clip-Zeitachse."""
    st = {**STYLES.get(account.upper(), STYLES["A"]), **(style or {})}
    size = max(28, int(height * 0.038))                                   # ~73 px bei 1920
    margin_h = int(width * (100 - WIDTH_PCT) / 200)
    margin_v = int(height * (100 - baseline_pct) / 100)                   # ASS misst von unten
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: sub,{st['font']},{size},{_ass_color(st['color'])},{_ass_color(st['accent'])},{_ass_color('#000000')},{_ass_color('#000000', 96)},0,0,0,0,100,100,0,0,1,{OUTLINE_PX},3,2,{margin_h},{margin_h},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    accent = _ass_color(st["accent"])
    base = _ass_color(st["color"])
    lines = []
    for block in chunks(words):
        for i, w in enumerate(block):
            s = float(w["start"]) - offset
            e = float(w["end"]) - offset
            if i + 1 < len(block):                                        # bis zum nächsten Wort stehen lassen
                e = float(block[i + 1]["start"]) - offset
            if duration is not None:
                e = min(e, duration)
            if e <= 0 or s >= (duration if duration is not None else 1e9):
                continue
            text = " ".join(
                (f"{{\\c{accent}}}{str(x.get('word','')).strip()}{{\\c{base}}}" if j == i else str(x.get("word", "")).strip())
                for j, x in enumerate(block)).strip()
            if not text:
                continue
            lines.append(f"Dialogue: 0,{_t(max(0.0, s))},{_t(e)},sub,,0,0,0,,{text}")
    return head + "\n".join(lines) + "\n"


def write_ass(words: list[dict], out: Path, width: int, height: int, account: str = "A", style: dict | None = None,
              baseline_pct: float = BASELINE_PCT, offset: float = 0.0, duration: float | None = None) -> Path | None:
    """ASS schreiben. None, wenn keine Wörter im Clip liegen (Musik oder kein Sprechen) – dann keine Untertitel."""
    words = [w for w in words if w.get("start") is not None and w.get("end") is not None and str(w.get("word", "")).strip()]
    if not words:
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build_ass(words, width, height, account, style, baseline_pct, offset, duration), encoding="utf-8")
    return out


def top_of_subtitles(height: int, baseline_pct: float = BASELINE_PCT, lines: int = MAX_LINES) -> int:
    """Oberkante des Untertitelblocks in Pixeln – der Hook muss darüber bleiben."""
    size = max(28, int(height * 0.038))
    return int(height * baseline_pct / 100) - int(lines * size * 1.25)
