"""Pflichttext per ffmpeg. Safe-Zones: Text oben ab 12 %, untere 20 % frei (TikTok-UI).
Der Text wird an ' · ' / ' | ' / Zeilenumbruch in Zeilen geteilt; die Schriftgröße wird so gewählt,
dass die längste Zeile in 90 % der Breite passt (drawtext bricht selbst nicht um)."""
import shutil, subprocess, tempfile
from pathlib import Path

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MAX_FONT, MIN_FONT, CHAR_W = 54, 34, 0.62          # DejaVuSans-Bold: Ø Zeichenbreite ≈ 0.62 × Schriftgröße


def probe_width(p: Path) -> int:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", str(p)],
                       capture_output=True, text=True, check=True)
    return int(r.stdout.strip().split(",")[0] or 1080)


def layout(text: str, width: int) -> tuple[list[str], int]:
    lines = [l.strip() for part in text.replace(" | ", "\n").replace(" · ", "\n").split("\n") for l in [part] if l.strip()]
    longest = max(len(l) for l in lines)
    size = int(min(MAX_FONT, (width * 0.9) / (CHAR_W * longest)))
    if size < MIN_FONT:                                 # zu lang → zusätzlich an Leerzeichen umbrechen
        max_chars = int((width * 0.9) / (CHAR_W * MIN_FONT))
        wrapped = []
        for l in lines:
            cur = ""
            for w in l.split():
                if len(cur) + len(w) + 1 > max_chars and cur:
                    wrapped.append(cur); cur = w
                else:
                    cur = f"{cur} {w}".strip()
            wrapped.append(cur)
        lines, size = wrapped, MIN_FONT
    return lines, size


def apply(src: Path, text: str, out_dir: Path, name: str | None = None) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (name or src.name)
    if not text or not text.strip():                    # kein Pflichttext → Clip unverändert übernehmen
        shutil.copyfile(src, out)
        return out
    lines, size = layout(text, probe_width(src))
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tf:
        tf.write("\n".join(lines)); textfile = tf.name
    vf = (f"drawtext=fontfile={FONT}:textfile={textfile}:fontcolor=white:fontsize={size}:line_spacing=8:"
          f"box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=h*0.12")
    subprocess.run(["ffmpeg", "-y", "-i", str(src), "-vf", vf, "-c:a", "copy",
                    "-c:v", "libx264", "-crf", "20", "-preset", "medium", str(out)],
                   check=True, capture_output=True)
    Path(textfile).unlink(missing_ok=True)
    return out


def _hex_to_ffmpeg(c: str) -> str:
    return c.replace("#", "0x") if c.startswith("#") else c


def apply_text_hook(src: Path, text: str, out_dir: Path, name: str | None = None, seconds: float = 2.0,
                    color: str = "white", accent: str = "#FF5A1F") -> Path:
    """Account-Branding A: Hook-Satz für `seconds` Sekunden oben (Safe-Zone ab 12 %), weiße Bold-Schrift,
    orangener Akzentbalken darunter. Identische Position für alle Clips; ohne Text → Kopie."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (name or src.name)
    if not text or not text.strip():
        shutil.copyfile(src, out)
        return out
    width = probe_width(src)
    lines, size = layout(text, width)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tf:
        tf.write("\n".join(lines)); textfile = tf.name
    en = f"enable='between(t,0,{seconds})'"
    n = len(lines)
    text_h = n * size + (n - 1) * 8
    y_text = "h*0.12"
    bar_y = f"h*0.12+{text_h + 14}"
    vf = (f"drawtext=fontfile={FONT}:textfile={textfile}:fontcolor={_hex_to_ffmpeg(color)}:fontsize={size}:line_spacing=8:"
          f"borderw=3:bordercolor=black@0.85:x=(w-text_w)/2:y={y_text}:{en},"
          f"drawbox=x=iw*0.18:y={bar_y}:w=iw*0.64:h=8:color={_hex_to_ffmpeg(accent)}@0.95:t=fill:{en}")
    subprocess.run(["ffmpeg", "-y", "-i", str(src), "-vf", vf, "-c:a", "copy",
                    "-c:v", "libx264", "-crf", "20", "-preset", "medium", str(out)],
                   check=True, capture_output=True)
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
