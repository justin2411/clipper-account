"""Pflichttext per ffmpeg. Safe-Zones: Text oben 15 %, untere 20 % frei (TikTok-UI)."""
import subprocess
from pathlib import Path

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def apply(src: Path, text: str, out_dir: Path, name: str | None = None) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (name or src.name)
    safe = text.replace(":", r"\:").replace("'", r"\'")
    vf = (f"drawtext=fontfile={FONT}:text='{safe}':fontcolor=white:fontsize=54:"
          f"box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=h*0.12")
    subprocess.run(["ffmpeg", "-y", "-i", str(src), "-vf", vf, "-c:a", "copy",
                    "-c:v", "libx264", "-crf", "20", "-preset", "medium", str(out)],
                   check=True, capture_output=True)
    return out


def hook_type_of(clip: Path) -> str:
    """Grobe Klassifikation für die Wochenauswertung. V1: aus Dateinamen/Rank; später aus Manifest."""
    n = clip.name.lower()
    return "reaction" if "react" in n else "moment"
