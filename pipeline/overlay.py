"""Text-Overlays per ffmpeg (drawtext, Text aus Datei → keine Escaping-Probleme).

Safe-Zones (TikTok-UI, 9:16):
  • Pflicht-Overlay der Kampagne: oben, Block innerhalb 10–22 % der Höhe.
  • Hook-Text (Account-Branding): unten, Block innerhalb 65–72 % der Höhe (unter dem Bildmittelpunkt,
    über der TikTok-Leiste). Max. 8 Wörter, max. 2 Zeilen, automatischer Umbruch, Schriftgröße automatisch.
  • Keine eingebrannten Untertitel (TikTok Auto-Captions).
drawtext bricht selbst nicht um – Zeilen werden hier vorbereitet, die Schriftgröße so gewählt,
dass die längste Zeile in 90 % der Breite und der Block in seine Zone passt."""
import re, shutil, subprocess, tempfile
from pathlib import Path

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
CHAR_W = 0.62                                       # DejaVuSans-Bold: Ø Zeichenbreite ≈ 0.62 × Schriftgröße
LINE_SP = 8
# Pflicht-Overlay (oben)
OV_TOP, OV_BOTTOM, OV_MAX_FONT, OV_MIN_FONT = 0.10, 0.22, 54, 30
# Hook-Text (unten)
HOOK_TOP, HOOK_BOTTOM, HOOK_MAX_FONT, HOOK_MIN_FONT = 0.65, 0.72, 72, 36
HOOK_MAX_WORDS, HOOK_MAX_LINES = 8, 2


def probe_size(p: Path) -> tuple[int, int]:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                        "-of", "csv=p=0", str(p)], capture_output=True, text=True, check=True)
    w, h = (r.stdout.strip().split(",") + ["1920"])[:2]
    return int(w or 1080), int(h or 1920)


def probe_width(p: Path) -> int:
    return probe_size(p)[0]


def _fit(lines: list[str], width: int, zone_h: float, max_font: int, min_font: int) -> int:
    """Größte Schriftgröße, bei der die längste Zeile in 90 % der Breite und der Block in zone_h Pixel passt."""
    longest = max(len(l) for l in lines) or 1
    n = len(lines)
    by_w = (width * 0.9) / (CHAR_W * longest)
    by_h = (zone_h - (n - 1) * LINE_SP) / (n * 1.15)   # 1.15: Zeilenhöhe inkl. Unterlängen
    return int(max(min_font, min(max_font, by_w, by_h)))


def _wrap(words: list[str], max_chars: int) -> list[str]:
    out, cur = [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > max_chars:
            out.append(cur); cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        out.append(cur)
    return out


def layout(text: str, width: int, height: int = 1920) -> tuple[list[str], int]:
    """Pflicht-Overlay: Zeilen an ' · ' / ' | ' / Zeilenumbruch, Schrift so, dass alles in 10–22 % passt."""
    lines = [l.strip() for part in text.replace(" | ", "\n").replace(" · ", "\n").split("\n") for l in [part] if l.strip()]
    zone_h = height * (OV_BOTTOM - OV_TOP)
    size = _fit(lines, width, zone_h, OV_MAX_FONT, OV_MIN_FONT)
    if max(len(l) for l in lines) * CHAR_W * size > width * 0.9:      # zu lang → zusätzlich an Leerzeichen umbrechen
        max_chars = int((width * 0.9) / (CHAR_W * OV_MIN_FONT))
        lines = [w for l in lines for w in _wrap(l.split(), max_chars)]
        size = _fit(lines, width, zone_h, OV_MAX_FONT, OV_MIN_FONT)
    return lines, size


def shorten_hook(text: str, max_words: int = HOOK_MAX_WORDS) -> str:
    """Hook auf max. 8 Wörter kürzen (an Wortgrenze, Satzzeichen am Schnitt entfernen, '…' anhängen)."""
    words = re.sub(r"\s+", " ", (text or "").strip()).split(" ")
    words = [w for w in words if w]
    if len(words) <= max_words:
        return " ".join(words)
    cut = " ".join(words[:max_words]).rstrip(",;:–-")
    return cut if cut.endswith(("…", "?", "!", ".")) else cut + "…"


def hook_layout(text: str, width: int, height: int) -> tuple[list[str], int]:
    """Hook-Text: ≤ 8 Wörter, ≤ 2 Zeilen (ausgewogen umgebrochen), Schrift automatisch für Zone 65–72 %."""
    text = shorten_hook(text)
    words = text.split()
    zone_h = height * (HOOK_BOTTOM - HOOK_TOP)
    one = [text]
    too_wide = _fit(one, width, zone_h, HOOK_MAX_FONT, HOOK_MIN_FONT) * CHAR_W * len(text) > width * 0.9
    if len(words) > 1 and (too_wide or len(text) > 22):
        # zwei Zeilen, möglichst gleich lang
        best = None
        for k in range(1, len(words)):
            a, b = " ".join(words[:k]), " ".join(words[k:])
            score = abs(len(a) - len(b))
            if best is None or score < best[0]:
                best = (score, [a, b])
        lines = best[1] if best else one
    else:
        lines = one
    lines = lines[:HOOK_MAX_LINES]
    size = _fit(lines, width, zone_h, HOOK_MAX_FONT, HOOK_MIN_FONT)
    while size == HOOK_MIN_FONT and max(len(l) for l in lines) * CHAR_W * size > width * 0.9 and len(lines[-1].split()) > 1:
        # passt selbst bei Mindestgröße nicht → letzte Wörter abschneiden
        lines[-1] = " ".join(lines[-1].split()[:-1]).rstrip(",;:–-") + "…"
        size = _fit(lines, width, zone_h, HOOK_MAX_FONT, HOOK_MIN_FONT)
    return lines, size


def _textfile(lines: list[str]) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tf:
        tf.write("\n".join(lines))
        return tf.name


def _render(src: Path, vf: str, out: Path) -> None:
    subprocess.run(["ffmpeg", "-y", "-i", str(src), "-vf", vf, "-c:a", "copy",
                    "-c:v", "libx264", "-crf", "20", "-preset", "medium", str(out)],
                   check=True, capture_output=True)


def apply(src: Path, text: str, out_dir: Path, name: str | None = None) -> Path:
    """Pflicht-Overlay der Kampagne: weiße Schrift auf halbtransparenter Box, Block in 10–22 % Höhe."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (name or src.name)
    if not text or not text.strip():                    # kein Pflichttext → Clip unverändert übernehmen
        shutil.copyfile(src, out)
        return out
    w, h = probe_size(src)
    lines, size = layout(text, w, h)
    textfile = _textfile(lines)
    pad = max(10, size // 4)
    vf = (f"drawtext=fontfile={FONT}:textfile={textfile}:fontcolor=white:fontsize={size}:line_spacing={LINE_SP}:"
          f"box=1:boxcolor=black@0.55:boxborderw={pad}:x=(w-text_w)/2:y=h*{OV_TOP}+{pad}")
    _render(src, vf, out)
    Path(textfile).unlink(missing_ok=True)
    return out


def _hex_to_ffmpeg(c: str) -> str:
    return c.replace("#", "0x") if c.startswith("#") else c


def apply_text_hook(src: Path, text: str, out_dir: Path, name: str | None = None, seconds: float = 2.0,
                    color: str = "white", accent: str = "#FF5A1F", style: str = "bar") -> Path:
    """Account-Branding über den Hook-Text (unten, Zone 65–72 %), `seconds` Sekunden eingeblendet.
    style='bar': Schrift in `color` mit schwarzer Kontur, Akzentbalken in `accent` darunter (A: weiß/orange).
    style='box': Schrift in `color` auf Box in `accent` (B: gelb/lila). Ohne Text → Kopie."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (name or src.name)
    if not text or not text.strip():
        shutil.copyfile(src, out)
        return out
    w, h = probe_size(src)
    lines, size = hook_layout(text, w, h)
    textfile = _textfile(lines)
    en = f"enable='between(t,0,{seconds})'"
    n = len(lines)
    text_h = int(n * size * 1.15 + (n - 1) * LINE_SP)
    center = (HOOK_TOP + HOOK_BOTTOM) / 2
    y_text = f"h*{center}-{text_h // 2}"
    col, acc = _hex_to_ffmpeg(color), _hex_to_ffmpeg(accent)
    if style == "box":
        pad = max(12, size // 4)
        vf = (f"drawtext=fontfile={FONT}:textfile={textfile}:fontcolor={col}:fontsize={size}:line_spacing={LINE_SP}:"
              f"box=1:boxcolor={acc}@0.92:boxborderw={pad}:x=(w-text_w)/2:y={y_text}:{en}")
    else:
        bar_h = max(6, size // 8)
        bar_y = f"ih*{center}+{text_h // 2 + 10}"      # drawbox: ih = Bildhöhe (h wäre die Boxhöhe)
        vf = (f"drawtext=fontfile={FONT}:textfile={textfile}:fontcolor={col}:fontsize={size}:line_spacing={LINE_SP}:"
              f"borderw=3:bordercolor=black@0.85:x=(w-text_w)/2:y={y_text}:{en},"
              f"drawbox=x=iw*0.2:y={bar_y}:w=iw*0.6:h={bar_h}:color={acc}@0.95:t=fill:{en}")
    _render(src, vf, out)
    Path(textfile).unlink(missing_ok=True)
    return out


def frame(src: Path, out_path: Path, at: float = 1.0, width: int = 540) -> Path:
    """Standbild (JPEG) für die Telegram-Vorschau."""
    subprocess.run(["ffmpeg", "-y", "-ss", str(at), "-i", str(src), "-frames:v", "1", "-vf", f"scale={width}:-1", "-q:v", "4", str(out_path)],
                   check=True, capture_output=True)
    return out_path


def hook_type_of(clip: Path) -> str:
    """Grobe Klassifikation für die Wochenauswertung. V1: aus Dateinamen/Rank; später aus Manifest."""
    n = clip.name.lower()
    return "reaction" if "react" in n else "moment"
