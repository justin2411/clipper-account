"""Aufruf von opensource-clipping (gepinnter Submodule-Commit) als Bibliothek.
Der Clipper kann nur URLs (YouTube/Drive-Datei) laden; wir laden die Footage selbst (Drive-Ordner, yt-dlp, ...)
und übergeben die lokale Datei, indem der Download-Schritt übersprungen wird."""
import os, shlex, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "opensource-clipping"


def run(source: Path, flags: str, work_dir: Path, label_url: str = "") -> list[Path]:
    """Schneidet `source` mit den Account-Flags. Rückgabe: fertige Clips (outputs/highlight_rank_N_ready.mp4)."""
    source = source.resolve()                          # VOR dem chdir absolut machen
    work_dir = work_dir.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    if str(VENDOR) not in sys.path:
        sys.path.insert(0, str(VENDOR))
    from clipping.config import build_config          # noqa: E402
    from clipping import engine, runner                # noqa: E402

    cwd = os.getcwd()
    os.chdir(work_dir)                                 # outputs/, Modelle, Fonts landen im Work-Dir
    try:
        argv = shlex.split(flags) + ["--url", label_url or str(source), "--source", "gdrive", "--ratio", "9:16"]
        cfg = build_config(argv)
        cfg.file_video_asli = str(source)
        engine.download_video = lambda *a, **k: None   # Datei liegt schon lokal
        manifest = runner.run_pipeline(cfg) or []
    finally:
        os.chdir(cwd)
    out = []
    for m in manifest:
        p = Path(m.get("video_path", ""))
        if p.is_file() and p.stat().st_size > 0:
            out.append(p)
    return out
