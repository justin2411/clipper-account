"""Aufruf von opensource-clipping (gepinnter Submodule-Commit) als Bibliothek.
Der Clipper kann nur URLs (YouTube/Drive-Datei) laden; wir laden die Footage selbst (Frame.io, Drive, ...)
und übergeben die lokale Datei, indem der Download-Schritt übersprungen wird.

Regeln (dauerhaft):
- Vertikale Quellen (Höhe > Breite, ffprobe inkl. Rotation) → kein Face-Tracking, direkter Schnitt (--static-crop).
  Der Clipper wendet --static-crop von Haus aus nur auf 1:1/3:4/4:5 an; ein idempotenter Ein-Zeilen-Patch
  am Vendor-Code (_patch_vendor) nimmt 9:16 dazu.
- Höchstens `max_clips_per_source` Clips pro Video (config/accounts.yaml, Standard 3)."""
import json, os, re, shlex, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "opensource-clipping"
DEFAULT_MAX_CLIPS = 3


def probe_dims(p: Path) -> tuple[int, int]:
    """(Breite, Höhe) wie angezeigt – Rotations-Metadaten (90/270) werden berücksichtigt."""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height:stream_tags=rotate:stream_side_data=rotation", "-of", "json", str(p)],
                       capture_output=True, text=True, check=True)
    s = json.loads(r.stdout)["streams"][0]
    w, h = int(s["width"]), int(s["height"])
    rot = int(float((s.get("tags") or {}).get("rotate", 0) or 0))
    for sd in s.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    if abs(rot) % 180 == 90:
        w, h = h, w
    return w, h


def is_vertical(p: Path) -> bool:
    w, h = probe_dims(p)
    return h > w


def _patch_vendor():
    """Static-Crop auch für 9:16 (idempotent, wird vor dem Import ausgeführt)."""
    f = VENDOR / "clipping" / "studio" / "render_hybrid.py"
    s = f.read_text()
    old = 'and rasio in ["1:1", "3:4", "4:5"]'
    if old in s:
        f.write_text(s.replace(old, 'and rasio in ["1:1", "3:4", "4:5", "9:16"]  # clipforge: static crop auch 9:16'))


def _cap_clips(argv: list[str], max_clips: int) -> list[str]:
    out, i = [], 0
    while i < len(argv):
        if argv[i] == "--clips" and i + 1 < len(argv):
            out += ["--clips", str(min(int(argv[i + 1]), max_clips))]; i += 2; continue
        if argv[i].startswith("--clips="):
            out.append(f"--clips={min(int(argv[i].split('=', 1)[1]), max_clips)}"); i += 1; continue
        out.append(argv[i]); i += 1
    if "--clips" not in out and not any(a.startswith("--clips=") for a in out):
        out += ["--clips", str(max_clips)]
    return out


def hooks_of(work_dir: Path) -> dict[str, str]:
    """rank → Hook-Satz (englischer Titel aus dem Clipper-Manifest bzw. gemini_response.json)."""
    out: dict[str, str] = {}
    for f in ("render_manifest.json", "gemini_response.json"):
        fp = work_dir / "outputs" / f
        if not fp.is_file():
            continue
        try:
            data = json.loads(fp.read_text())
        except Exception:
            continue
        items = data if isinstance(data, list) else data.get("clips") or data.get("highlights") or []
        for m in items:
            if not isinstance(m, dict) or "rank" not in m:
                continue
            hook = m.get("title_inggris") or m.get("youtube_title_final") or m.get("thumbnail_text") or m.get("title") or ""
            if hook and str(m["rank"]) not in out:
                out[str(m["rank"])] = str(hook).strip()
    return out


def run(source: Path, flags: str, work_dir: Path, label_url: str = "", max_clips: int = DEFAULT_MAX_CLIPS) -> list[Path]:
    """Schneidet `source` mit den Account-Flags. Rückgabe: fertige Clips (outputs/highlight_rank_N_ready.mp4).
    Hook-Sätze dazu: hooks_of(work_dir)[rank]."""
    source = source.resolve()                          # VOR dem chdir absolut machen
    work_dir = work_dir.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    _patch_vendor()
    if str(VENDOR) not in sys.path:
        sys.path.insert(0, str(VENDOR))
    from clipping.config import build_config          # noqa: E402
    from clipping import engine, runner                # noqa: E402

    argv = _cap_clips(shlex.split(flags), max_clips)
    vertical = is_vertical(source)
    if vertical and "--static-crop" not in argv:
        argv.append("--static-crop")
    argv += ["--url", label_url or str(source), "--source", "gdrive", "--ratio", "9:16"]
    print(f"[clipper] {source.name}: {'vertikal → kein Face-Tracking' if vertical else 'horizontal → Face-Tracking'}; argv={' '.join(argv[:-6])}")

    cwd = os.getcwd()
    os.chdir(work_dir)                                 # outputs/, Modelle, Fonts landen im Work-Dir
    try:
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
    # Fallback: fertige Renders, die im Manifest fehlen (z.B. Thumbnail-Schritt nach dem Render fehlgeschlagen)
    for p in sorted((work_dir / "outputs").glob("highlight_rank_*_ready.mp4")):
        if p not in out and p.stat().st_size > 0 and "dev_mode" not in p.name:
            out.append(p)
    return sorted(out, key=lambda p: int(re.search(r"rank_(\d+)", p.name).group(1)))[:max_clips]
