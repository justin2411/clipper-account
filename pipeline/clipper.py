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
    """Idempotente Mini-Patches am Vendor-Code (vor dem Import):
    1) Static-Crop auch für 9:16.  2) Untertitel-Farben/Box aus cfg statt hart kodiert (Branding je Account)."""
    f = VENDOR / "clipping" / "studio" / "render_hybrid.py"
    s = f.read_text()
    old = 'and rasio in ["1:1", "3:4", "4:5"]'
    if old in s:
        f.write_text(s.replace(old, 'and rasio in ["1:1", "3:4", "4:5", "9:16"]  # clipforge: static crop auch 9:16'))
    f = VENDOR / "clipping" / "studio" / "subtitles.py"
    s = f.read_text()
    KARAOKE, PRIMARY = r"\\c&H00FFFF&", r"\\c&HFFFFFF&"
    K_NEW = r"\\c{getattr(cfg, 'ass_karaoke', '&H00FFFF&')}"
    P_NEW = r"\\c{getattr(cfg, 'ass_primary_tag', '&HFFFFFF&')}"
    out_lines, changed = [], False
    for line in s.splitlines(keepends=True):
        orig = line
        if "&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,{outline_val}" in line:
            line = line.replace("&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,{outline_val}",
                                "{getattr(cfg, 'ass_primary', '&H00FFFFFF')},&H00000000,{getattr(cfg, 'ass_back', '&H80000000')},0,0,0,0,100,100,0,0,{getattr(cfg, 'ass_border_style', 1)},{outline_val}")
        elif 'c_tag = "' + PRIMARY + '"' in line:
            line = line.replace('c_tag = "' + PRIMARY + '"', 'c_tag = f"' + P_NEW + '"')
        elif (KARAOKE in line or PRIMARY in line) and line.lstrip().startswith(("f\"", "anim_tag = f\"")):
            line = line.replace(KARAOKE, K_NEW).replace(PRIMARY, P_NEW)
        if line != orig:
            changed = True
        out_lines.append(line)
    if changed:
        f.write_text("".join(out_lines))


COLD_OPEN_PROMPT = """

CLIPFORGE – COLD OPEN & CAPTION (WAJIB, prioritas di atas aturan hook standar):
- Setiap klip HARUS dimulai langsung di momen terkuat (cold open). Tidak ada teaser, tidak ada lompatan kembali.
- Kalimat pertama yang terdengar harus memancing pertanyaan atau ketegangan dan tetap bisa dipahami TANPA konteks video penuh.
- Geser start_time ke awal kalimat kuat tersebut; jangan mulai di tengah kalimat.
- Tambahkan untuk setiap klip dua field tambahan (bahasa Inggris natural):
  - "caption_hook": 1 kalimat hook untuk caption, MAKSIMAL 12 kata, tanpa hashtag, tanpa emoji, memancing rasa ingin tahu, tidak clickbait palsu.
  - "pinned_comment": 1 pertanyaan (maksimal 15 kata) untuk komentar yang dipin, yang memancing penonton menjawab/berdebat.
"""


def _install_prompt_patch(engine):
    """Cold-Open-Regeln + Zusatzfelder an den zentralen Analyse-Prompt anhängen (Monkeypatch, kein Vendor-Edit)."""
    if getattr(engine, "_clipforge_prompt_patched", False):
        return
    orig = engine.get_analysis_prompt

    def patched(*a, **k):
        return orig(*a, **k) + COLD_OPEN_PROMPT

    engine.get_analysis_prompt = patched
    engine._clipforge_prompt_patched = True


def _install_moments_patch(engine, work_dir: Path):
    """Stufe 3: eigene Momentwahl mit Bewertungsraster (pipeline/moments.py) statt der Vendor-Analyse; Wort-Zeitstempel
    der Transkription nach outputs/words.json (Schnitt auf Wortgrenzen, Stufe 4). Monkeypatch pro Lauf (work_dir wechselt)."""
    from pipeline import moments
    out_dir = work_dir / "outputs"
    orig_tr = getattr(engine, "_clipforge_orig_transcribe", None) or engine.transcribe_video

    def transcribe(*a, **k):
        transcript, segs = orig_tr(*a, **k)
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "words.json").write_text(json.dumps(segs))
        except Exception as e:
            print("[clipper] words.json:", e)
        return transcript, segs

    engine._clipforge_orig_transcribe = orig_tr
    engine.transcribe_video = transcribe
    engine.analyze_with_ai = lambda transcript, cfg: moments.analyze(transcript, cfg, out_dir)


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


def _words(s: str, n: int) -> str:
    w = str(s or "").strip().split()
    return " ".join(w[:n]).rstrip(",;:") if len(w) > n else " ".join(w)


def hooks_of(work_dir: Path) -> dict[str, dict]:
    """rank → {hook, caption_hook (≤12 Wörter), pinned_comment} aus gemini_response.json / Manifest."""
    out: dict[str, dict] = {}
    for f in ("gemini_response.json", "render_manifest.json"):
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
            r = str(m["rank"])
            cur = out.setdefault(r, {"hook": "", "caption_hook": "", "pinned_comment": "", "context_line": "", "accent_word": "", "scores": None})
            cur["hook"] = cur["hook"] or str(m.get("title_inggris") or m.get("youtube_title_final") or m.get("thumbnail_text") or m.get("title") or "").strip()
            cur["caption_hook"] = cur["caption_hook"] or _words(m.get("caption_hook") or m.get("description_hook") or m.get("title_inggris") or "", 12)
            cur["pinned_comment"] = cur["pinned_comment"] or str(m.get("pinned_comment") or "").strip()
            cur["context_line"] = cur["context_line"] or str(m.get("context_line") or "").strip()
            cur["accent_word"] = cur["accent_word"] or str(m.get("accent_word") or "").strip()
            cur["scores"] = cur["scores"] or (m.get("scores") if isinstance(m.get("scores"), dict) else None)
            cur.setdefault("start", m.get("start_time")); cur.setdefault("end", m.get("end_time"))
            cur.setdefault("description", str(m.get("description_hook") or "") + " " + str(m.get("description_context") or ""))
            cur.setdefault("transcript", str(m.get("transcript_text") or m.get("teks") or ""))
    return out


def run(source: Path, flags: str, work_dir: Path, label_url: str = "", max_clips: int = DEFAULT_MAX_CLIPS,
        subtitle_style: dict | None = None) -> list[Path]:
    """Schneidet `source` mit den Account-Flags. Rückgabe: fertige Clips (outputs/highlight_rank_N_ready.mp4).
    Hook-Sätze dazu: hooks_of(work_dir)[rank]. subtitle_style (config/accounts.yaml): ASS-Farben/Box für Karaoke-Untertitel."""
    source = source.resolve()                          # VOR dem chdir absolut machen
    work_dir = work_dir.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    _patch_vendor()
    if str(VENDOR) not in sys.path:
        sys.path.insert(0, str(VENDOR))
    from clipping.config import build_config          # noqa: E402
    from clipping import engine, runner                # noqa: E402
    _install_prompt_patch(engine)
    _install_moments_patch(engine, work_dir)

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
        for k, v in (subtitle_style or {}).items():      # ass_primary, ass_back, ass_border_style, ass_karaoke, ass_primary_tag
            setattr(cfg, k, v)
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
