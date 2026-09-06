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


# Safe-Zones (1080×1920): oben 140 px, unten 400 px, rechts 180 px frei; Hook nie unter 72 % Höhe.
SAFE_TOP, SAFE_BOTTOM, SAFE_RIGHT = 140, 400, 180
HOOK_MAX_Y = 0.72
DEFAULT_STYLE = {"font": "dejavu-bold", "color": "#FFFFFF", "outline_px": 5, "outline_color": "#000000", "accent_color": None,
                 "accent_mode": "bar", "box_color": None, "align": "center", "y_pct": 0.685, "max_lines": 2, "size_max": 72, "size_min": 36,
                 # Feinjustierung (settings.visual): size = px bei 1080 Breite, weight nur für variable Fonts
                 "size": None, "weight": None, "spacing": 0, "line_h": None, "x_pct": 50, "w_pct": 84, "case": "none",
                 "box": None, "box_opacity": 55, "box_pad": 10, "box_radius": 10, "shadow": 0, "anim": "none", "safe_right": SAFE_RIGHT, "safe_top": SAFE_TOP}
ANIM_S = 0.4                                                       # Einblendung (pop/slide/typewriter) in Sekunden


def style_from_visual(vis: dict) -> dict:
    """settings.visual (Dashboard → Feinjustierung) → Style-Tokens für apply_text_hook. Altformat (box:true, align) wird gemappt."""
    box = vis.get("box")
    if isinstance(box, bool): box = "solid" if box else "none"
    box = box or "none"
    mode = vis.get("accent_mode") or ("none" if box == "solid" and not vis.get("accent_mode") else "keyword")
    g = lambda k, d=None: vis[k] if vis.get(k) is not None else d
    return {"font": str(vis["font"]).lower().replace(" ", "-"), "color": g("color", "#FFFFFF"), "accent_color": g("accent"), "accent_mode": mode,
            "box": box, "box_color": g("box_color", g("accent") if box == "solid" else "#000000"), "box_opacity": float(g("box_opacity", 55)),
            "box_pad": float(g("box_pad", 10)), "box_radius": float(g("box_radius", 10)),
            "outline_px": int(g("outline_px", 5)), "y_pct": float(g("hook_y_pct", 68)) / 100, "max_lines": int(g("hook_max_lines", 2)),
            "align": g("hook_align", g("align", "center")), "size": g("hook_size"), "weight": g("hook_weight"), "spacing": float(g("hook_spacing", 0)),
            "line_h": g("hook_line_h"), "x_pct": float(g("hook_x_pct", 50)), "w_pct": float(g("hook_w_pct", 84)), "case": g("hook_case", "none"),
            "shadow": int(g("shadow", 0)), "anim": g("anim", "none"),
            "safe_right": int(g("safe_right_px", SAFE_RIGHT)), "safe_top": int(g("safe_top_px", SAFE_TOP))}


def _style(style: dict | None) -> dict:
    st = {**DEFAULT_STYLE, **{k: v for k, v in (style or {}).items() if v is not None}}
    if st.get("box") is None:                                     # Altformat: box_color gesetzt = solide Box
        st["box"] = "solid" if (st.get("box_color") and st.get("accent_mode") == "box") else "none"
    if st["box"] == "solid" and st.get("accent_mode") == "box" and "box_opacity" not in (style or {}):
        st["box_opacity"] = 100
    return st


def accent_indices(words: list[str], mode: str, accent_word: str | None) -> set[int]:
    """Welche Wörter in der Akzentfarbe: none | first | last2 | keyword (Akzentwort aus der Momentwahl, Alt: 'word')."""
    n = len(words)
    if not n or mode in ("none", "box", "bar", None):
        return set()
    if mode == "first":
        return {0}
    if mode == "last2":
        return {n - 2, n - 1} if n >= 2 else {0}
    strip = lambda s: s.lower().strip(".,!?\"'’“”:;")
    acc = strip(accent_word or "")
    for i, w in enumerate(words):
        if acc and strip(w) == acc:
            return {i}
    return {n - 1} if mode in ("keyword", "word") and n else set()


def _hook_render_args(st: dict, text: str, accent_word: str | None, width: int) -> dict:
    scale = width / 1080
    size = int(round(float(st["size"]) * scale)) if st.get("size") else int(st["size_max"])
    words = (text.upper() if st.get("case") == "upper" else text).split()
    return dict(font=st["font"], size_max=max(size, int(st["size_min"])), size_min=int(min(st["size_min"], size)), color=st["color"],
                outline_px=int(st["outline_px"]), outline_color=st["outline_color"], accent_color=st.get("accent_color"),
                accent_idx=accent_indices(words, st.get("accent_mode"), accent_word), box=st["box"],
                box_color=st.get("box_color") if st["box"] != "none" else None, box_opacity=float(st.get("box_opacity", 55)),
                box_pad=int(round(float(st.get("box_pad", 10)) * scale)), box_radius=int(round(float(st.get("box_radius", 10)) * scale)),
                align=st["align"], max_lines=int(st["max_lines"]), weight=st.get("weight"), spacing=float(st.get("spacing") or 0) * scale,
                line_h=st.get("line_h"), case=st.get("case", "none"), shadow=int(st.get("shadow") or 0))


def hook_box(st: dict, width: int) -> tuple[int, int]:
    """Textbox: Breite w_pct % der Videobreite, Mitte bei x_pct %, immer innerhalb der Safe-Zone (rechts 180 px, 60 px Rand)."""
    margin = 60
    lo, hi = margin, width - int(st.get("safe_right", SAFE_RIGHT)) - margin
    bw = int(width * float(st.get("w_pct", 84)) / 100)
    bw = max(200, min(bw, hi - lo))
    cx = int(width * float(st.get("x_pct", 50)) / 100)
    left = max(lo, min(cx - bw // 2, hi - bw))
    return left, bw


def hook_png(text: str, style: dict, width: int, height: int, accent_word: str | None, out: Path,
             visible_words: int | None = None) -> tuple[Path, int, int]:
    """Hook-Text als PNG (pipeline/text.py). Rückgabe: (png, x, y) für ffmpeg overlay – Block um y_pct zentriert, nie unter 72 %."""
    from pipeline import text as T
    st = _style(style)
    left, box_w = hook_box(st, width)
    max_h = int(height * 0.075) if not st.get("size") else int(height * 0.16)      # feste Größe: Block darf bis ~16 % hoch werden
    img = T.render(text, box_w, max_h, visible_words=visible_words, **_hook_render_args(st, text, accent_word, width))
    T.save(img, out)
    y_center = int(height * float(st["y_pct"]))
    y = min(y_center - img.height // 2, int(height * HOOK_MAX_Y) - img.height)
    y = max(y, int(st.get("safe_top", SAFE_TOP)))
    if st["align"] == "left": x = left
    elif st["align"] == "right": x = left + box_w - img.width
    else: x = left + (box_w - img.width) // 2
    return out, int(x), int(y)


def best_motion_frame(src: Path, window_s: float, min_scene: float = 0.4, min_luma: float = 40.0) -> float:
    """Zeitpunkt (s) des Frames mit der höchsten Bewegung (scene score) im Fenster, Frames mit scene > min_scene bevorzugt,
    dunkle Frames (Ø Luma < min_luma, z.B. Schwarzblende nach einem Cut) ausgeschlossen. Fallback 1.0 s."""
    r = subprocess.run(["ffmpeg", "-v", "info", "-t", f"{window_s:.2f}", "-i", str(src),
                        "-vf", "scale=240:-2,select='gte(scene,0)',signalstats,metadata=print", "-f", "null", "-"],
                       capture_output=True, text=True)
    frames: list[tuple[float, float, float]] = []      # (pts, scene, luma)
    cur = {}
    for line in r.stderr.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            if "pts" in cur: frames.append((cur["pts"], cur.get("scene", 0.0), cur.get("luma", 0.0)))
            cur = {"pts": float(m.group(1))}
        m = re.search(r"lavfi\.scene_score=([\d.]+)", line)
        if m: cur["scene"] = float(m.group(1))
        m = re.search(r"lavfi\.signalstats\.YAVG=([\d.]+)", line)
        if m: cur["luma"] = float(m.group(1))
    if "pts" in cur: frames.append((cur["pts"], cur.get("scene", 0.0), cur.get("luma", 0.0)))
    bright = [f for f in frames if f[2] >= min_luma and f[0] >= 0.15]
    if not bright:
        return 1.0
    hot = [f for f in bright if f[1] > min_scene]
    ranked = sorted(hot or bright, key=lambda f: f[1], reverse=True)[:6]
    for pts, _, _ in ranked:                           # Kandidaten prüfen: der per -ss extrahierte Frame muss wirklich hell sein
        if _frame_luma(src, pts) >= min_luma:
            return pts
    return 1.0


def _frame_luma(src: Path, at: float) -> float:
    r = subprocess.run(["ffmpeg", "-v", "info", "-ss", f"{at:.3f}", "-i", str(src), "-frames:v", "1",
                        "-vf", "scale=120:-2,signalstats,metadata=print", "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r"lavfi\.signalstats\.YAVG=([\d.]+)", r.stderr)
    return float(m.group(1)) if m else 0.0


def cover_frame(src: Path, text: str, style: dict, accent_word: str | None, out_png: Path, out_jpg: Path | None = None) -> Path:
    """Cover: Frame mit der stärksten Bewegung im ersten Drittel (select='gt(scene,0.4)', sonst 1.0 s), Hook-Text groß
    (innerhalb der Safe-Zones, Mitte ≈ 45 % Höhe). PNG für das Video (erster Frame), JPEG für R2/Blotato-Vorschau."""
    from PIL import Image
    from pipeline import text as T
    w, h = probe_size(src)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
                               capture_output=True, text=True).stdout.strip() or 10)
    tmp = out_png.with_suffix(".base.png")
    at = best_motion_frame(src, max(1.0, dur / 3))
    subprocess.run(["ffmpeg", "-y", "-ss", f"{at:.3f}", "-i", str(src), "-frames:v", "1", str(tmp)], check=True, capture_output=True)
    base = Image.open(tmp).convert("RGBA")
    st = _style(style)
    args = _hook_render_args(st, text, accent_word, w)
    args.update(size_max=140, size_min=64, outline_px=8, align="center", max_lines=3, box_pad=int(args["box_pad"] * 1.6), box_radius=int(args["box_radius"] * 1.6))
    img = T.render(text, w - SAFE_RIGHT - 120, int(h * 0.30), **args)
    x = 60 + (w - SAFE_RIGHT - 120 - img.width) // 2
    y = int(h * 0.45) - img.height // 2
    base.alpha_composite(img, (max(0, x), max(SAFE_TOP, y)))
    base.convert("RGB").save(out_png, "PNG")
    if out_jpg:
        base.convert("RGB").save(out_jpg, "JPEG", quality=88)
    tmp.unlink(missing_ok=True)
    return out_png


def _ending_filters(ending: dict | None, dur: float) -> tuple[str, str]:
    """Video-/Audio-Filter für das Clip-Ende: freeze (letzter Frame steht) oder black_cut (kurze Blende auf Schwarz)."""
    if not ending:
        return "", ""
    t = str(ending.get("type", ""))
    if t == "freeze":
        sec = float(ending.get("seconds", 0.3))
        return f"tpad=stop_mode=clone:stop_duration={sec}", f"apad=pad_dur={sec}"
    if t == "black_cut":
        fade, black = float(ending.get("fade", 0.12)), float(ending.get("black", 0.25))
        st = max(0.0, dur - fade)
        return f"fade=t=out:st={st:.3f}:d={fade},tpad=stop_mode=add:stop_duration={black}:color=black", f"afade=t=out:st={st:.3f}:d={fade},apad=pad_dur={black}"
    return "", ""


def _ease(t_expr: str = "t") -> str:
    """ease-out cubic über ANIM_S Sekunden als ffmpeg-Ausdruck (0 → 1)."""
    return f"(1-pow(1-min(1,{t_expr}/{ANIM_S}),3))"


def _hook_filters(src: Path, text: str, st: dict, w: int, h: int, seconds: float, accent_word: str | None, out_dir: Path, stem: str) -> tuple[list[str], list[str], int]:
    """Baut Eingaben + filter_complex-Kette für den Hook-Text: Box (solid im PNG, blur per boxblur auf dem Video),
    Einblendung anim = none | pop (Scale 0.5→1) | slide (von unten) | typewriter (Wort für Wort). Rückgabe (inputs, filters, png_height).
    Der Kette liegt [0:v] an, sie endet in [hv]."""
    from PIL import Image
    en = f"enable='between(t,0,{seconds})'"
    png, x, y = hook_png(text, st, w, h, accent_word, out_dir / f"{stem}.hook.png")
    pw, ph = Image.open(png).size
    inputs, fc = [], []
    cur = "[0:v]"
    if st["box"] == "blur":                                        # Bereich hinter dem Text weichzeichnen
        pad = int(st.get("box_pad", 10)) + 6
        bx, by = max(0, x - pad), max(0, y - pad)
        bw, bh = min(w - bx, pw + 2 * pad), min(h - by, ph + 2 * pad)
        bw -= bw % 2; bh -= bh % 2
        fc.append(f"{cur}split[b0][b1];[b1]crop={bw}:{bh}:{bx}:{by},boxblur=14:2[bl];[b0][bl]overlay=x={bx}:y={by}:{en}[bg]")
        cur = "[bg]"
    anim = str(st.get("anim") or "none")
    n_words = len(text.split())
    if anim == "typewriter" and n_words > 1:
        step = ANIM_S / n_words
        for k in range(1, n_words + 1):
            p_k, xk, yk = hook_png(text, st, w, h, accent_word, out_dir / f"{stem}.hook{k}.png", visible_words=k)
            idx = inputs.count("-i") + 1
            inputs += ["-i", str(p_k)]
            t0, t1 = round((k - 1) * step, 3), (round(k * step, 3) if k < n_words else seconds)
            fc.append(f"{cur}[{idx}:v]overlay=x={xk}:y={yk}:enable='between(t,{t0},{t1})'[t{k}]")
            cur = f"[t{k}]"
        fc[-1] = fc[-1].replace(f"[t{n_words}]", "[hv]")
        return inputs, fc, ph
    idx = inputs.count("-i") + 1
    if anim in ("pop", "slide"):
        inputs += ["-loop", "1", "-t", f"{seconds:.3f}", "-i", str(png)]
        e = _ease()
        if anim == "pop":
            cx, cy = x + pw / 2, y + ph / 2
            fc.append(f"[{idx}:v]format=rgba,scale=w='max(2,iw*(0.5+0.5*{e}))':h=-1:eval=frame,fade=t=in:st=0:d={ANIM_S / 2}:alpha=1[ha];"
                      f"{cur}[ha]overlay=x='{cx:.1f}-w/2':y='{cy:.1f}-h/2':{en}[hv]")
        else:
            fc.append(f"[{idx}:v]format=rgba,fade=t=in:st=0:d={ANIM_S}:alpha=1[ha];"
                      f"{cur}[ha]overlay=x={x}:y='{y}+140*(1-{e})':{en}[hv]")
        return inputs, fc, ph
    inputs += ["-i", str(png)]
    fc.append(f"{cur}[{idx}:v]overlay=x={x}:y={y}:{en}[hv]")
    if st.get("accent_mode") == "bar" and st.get("accent_color"):
        fc[-1] = fc[-1].replace("[hv]", "[h0]") + f";[h0]drawbox=x=iw*0.2:y={y + ph + 8}:w=iw*0.6:h=8:color={_hex_to_ffmpeg(st['accent_color'])}@0.95:t=fill:{en}[hv]"
    return inputs, fc, ph


def apply_text_hook(src: Path, text: str, out_dir: Path, name: str | None = None, seconds: float = 2.0,
                    color: str = "white", accent: str = "#FF5A1F", style: str | dict = "bar", accent_word: str | None = None,
                    cover: bool = True, ending: dict | None = None) -> tuple[Path, Path | None]:
    """Hook-Text (Zone 65–72 %, `seconds` s) + Cover-Frame als erster Frame (2 Frames, Blotato videoCoverTimestamp=0).
    style: 'bar' (A: weiß, Akzentbalken) | 'box' (B: Text auf Box) | dict mit Tokens aus config/brand.yaml / settings.visual.
    Rückgabe: (Video, Cover-JPEG oder None). Ohne Text → Kopie."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (name or src.name)
    if not text or not text.strip():
        shutil.copyfile(src, out)
        return out, None
    w, h = probe_size(src)
    if isinstance(style, dict):
        st = _style(style)
    elif style == "box":
        st = _style({"font": "dejavu-bold", "color": color, "box_color": accent, "accent_mode": "box", "align": "center"})
    else:
        st = _style({"font": "dejavu-bold", "color": color, "accent_color": accent, "accent_mode": "bar", "align": "center"})
    seconds = float(st.get("hook_seconds", seconds))
    ending = ending if ending is not None else st.get("ending")
    extra_inputs, fc, _ = _hook_filters(src, text, st, w, h, seconds, accent_word, out_dir, out.stem)
    inputs = ["-i", str(src), *extra_inputs]
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)], capture_output=True, text=True).stdout.strip() or 0)
    vf_end, af_end = _ending_filters(ending, dur)
    audio_src = "[0:a]"
    if vf_end:
        fc[-1] = fc[-1].replace("[hv]", "[he]") + f";[he]{vf_end}[hv];[0:a]{af_end}[ae]"
        audio_src = "[ae]"
    cover_jpg = None
    if cover:
        cover_png = cover_frame(src, text, st, accent_word, out_dir / f"{out.stem}.cover.png", out_dir / f"{out.stem}.cover.jpg")
        cover_jpg = out_dir / f"{out.stem}.cover.jpg"
        ci = inputs.count("-i")
        inputs += ["-loop", "1", "-t", "0.067", "-i", str(cover_png)]
        fc.append(f"[{ci}:v]scale={w}:{h},format=yuv420p,setsar=1,fps=30[cv];[hv]fps=30,setsar=1,format=yuv420p[vv];[cv][vv]concat=n=2:v=1:a=0[v];{audio_src}adelay=67|67[a]")
        maps = ["-map", "[v]", "-map", "[a]"]
    else:
        fc.append(f"[hv]format=yuv420p[v];{audio_src}anull[a]"); maps = ["-map", "[v]", "-map", "[a]"]
    subprocess.run(["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(fc), *maps, "-c:v", "libx264", "-crf", "19", "-preset", "medium",
                    "-pix_fmt", "yuv420p", "-r", "30", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
                    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", str(out)], check=True, capture_output=True)
    return out, cover_jpg


def frame(src: Path, out_path: Path, at: float = 1.0, width: int = 540) -> Path:
    """Standbild (JPEG) für die Telegram-Vorschau."""
    subprocess.run(["ffmpeg", "-y", "-ss", str(at), "-i", str(src), "-frames:v", "1", "-vf", f"scale={width}:-1", "-q:v", "4", str(out_path)],
                   check=True, capture_output=True)
    return out_path


def hook_type_of(clip: Path) -> str:
    """Grobe Klassifikation für die Wochenauswertung. V1: aus Dateinamen/Rank; später aus Manifest."""
    n = clip.name.lower()
    return "reaction" if "react" in n else "moment"
