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
# Safe-Zones (1080×1920): oben 140 px, unten 400 px, rechts 180 px frei; Hook nie unter 72 % Höhe.
SAFE_TOP, SAFE_BOTTOM, SAFE_RIGHT = 140, 400, 180
HOOK_MAX_Y = 0.72
ANIM_S = 0.4                                                       # Einblendung (fade/pop/slide/typewriter) in Sekunden
OVERLAY_HOOK_GAP = 0.08                                            # Mindestabstand Overlay ↔ Hook: 8 % der Höhe


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


OVERLAY_STYLE_DEFAULTS = {"show": "auto", "text": "", "font": "Montserrat", "size": 34, "weight": 700, "color": "#FFFFFF",
                          "case": "none", "y_pct": 14, "x_pct": 50, "w_pct": 84, "align": "center", "lines": 2,
                          "box": "solid", "box_color": "#000000", "box_opacity": 55, "box_pad": 10, "box_radius": 10,
                          "outline_px": 2, "shadow": 1, "anim": "fade", "duration": 0,
                          "safe_top": SAFE_TOP, "safe_right": SAFE_RIGHT}


SPAN_RE = re.compile(r'<span[^>]*color\s*:\s*(#[0-9a-fA-F]{3,6})[^>]*>(.*?)</span>', re.S | re.I)


def parse_colored(text: str) -> tuple[str, dict[int, str]]:
    """Overlay-Text mit farbigen Teilstücken: <span style="color:#RRGGBB">Wort</span> → (reiner Text, {Wort-Index: Farbe}).
    Alles andere an Auszeichnung wird entfernt, damit nie ein Tag im Bild landet."""
    out, colors, idx, pos = [], {}, 0, 0
    for m in SPAN_RE.finditer(text or ""):
        for part, col in ((text[pos:m.start()], None), (m.group(2), m.group(1))):
            for w in re.sub(r"<[^>]+>", "", part).split():
                out.append(w)
                if col: colors[idx] = col if len(col) == 7 else "#" + "".join(c * 2 for c in col.lstrip("#"))
                idx += 1
        pos = m.end()
    for w in re.sub(r"<[^>]+>", "", (text or "")[pos:]).split():
        out.append(w); idx += 1
    return " ".join(out), colors


def overlay_style_from_visual(vis: dict) -> dict:
    """settings.visual.overlay (Dashboard → Feinjustierung) → Tokens für apply(). Erbt nichts vom Hook."""
    o = dict((vis or {}).get("overlay") or {})
    st = {**OVERLAY_STYLE_DEFAULTS, **{k: v for k, v in o.items() if v is not None}}
    if isinstance(st.get("box"), bool): st["box"] = "solid" if st["box"] else "none"
    st["safe_top"] = int((vis or {}).get("safe_top_px") or SAFE_TOP)
    st["safe_right"] = int((vis or {}).get("safe_right_px") or SAFE_RIGHT)
    return st


def overlay_png(text: str, st: dict, width: int, height: int, out: Path) -> tuple[Path, int, int, int]:
    """Overlay oben als PNG (eigener Layer, unabhängig vom Hook). Rückgabe (png, x, y, Höhe).
    Der Block sitzt mit seiner Oberkante bei y_pct, bleibt aber immer unter der oberen Safe-Zone.
    Farbige Teilstücke (<span style="color:…">) werden als Wortfarben gezeichnet, übrige Tags entfernt."""
    from pipeline import text as T
    text, colors = parse_colored(text)
    scale = width / 1080
    box_w = max(200, int(width * float(st.get("w_pct", 84)) / 100))
    margin = 60
    hi = width - int(st.get("safe_right", SAFE_RIGHT)) - margin
    box_w = min(box_w, max(200, hi - margin))
    img = T.render(text, box_w, int(height * 0.28),
                   font=str(st.get("font") or "Montserrat").lower().replace(" ", "-"),
                   size_max=int(round(float(st.get("size", 34)) * scale)), size_min=max(14, int(round(float(st.get("size", 34)) * scale * 0.6))),
                   color=str(st.get("color", "#FFFFFF")), outline_px=int(st.get("outline_px", 2)), outline_color="#000000",
                   accent_color=None, accent_idx=set(), color_map=colors, box=str(st.get("box", "solid")), box_color=str(st.get("box_color", "#000000")),
                   box_opacity=float(st.get("box_opacity", 55)), box_pad=int(round(float(st.get("box_pad", 10)) * scale)),
                   box_radius=int(round(float(st.get("box_radius", 10)) * scale)), align=str(st.get("align", "center")),
                   max_lines=int(st.get("lines", 2)), weight=st.get("weight"), case=str(st.get("case", "none")),
                   shadow=int(st.get("shadow", 0)))
    T.save(img, out)
    cx = int(width * float(st.get("x_pct", 50)) / 100)
    left = max(margin, min(cx - box_w // 2, hi - box_w))
    if str(st.get("align")) == "left": x = left
    elif str(st.get("align")) == "right": x = left + box_w - img.width
    else: x = left + (box_w - img.width) // 2
    y = max(int(st.get("safe_top", SAFE_TOP)), int(height * float(st.get("y_pct", 14)) / 100))
    y = min(y, int(height * 0.45) - img.height)                     # nie in die untere Hälfte rutschen
    return out, int(max(0, x)), int(max(0, y)), int(img.height)


def apply(src: Path, text: str, out_dir: Path, name: str | None = None, style: dict | None = None,
          fallback: str = "") -> tuple[Path, dict]:
    """Overlay oben als eigener Layer (Pflichttext der Kampagne oder eigener Text).
    show: auto = nur wenn die Kampagne einen Pflichttext vorgibt, always = immer, never = nie.
    duration > 0 blendet nach n Sekunden aus, anim fade/slide als 0,4-s-Einblendung.
    Rückgabe: (Video, Geometrie) – die Geometrie braucht der Kollisionsschutz für den Hook."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (name or src.name)
    st = {**OVERLAY_STYLE_DEFAULTS, **{k: v for k, v in (style or {}).items() if v is not None}}
    required = (text or "").strip()
    show = str(st.get("show", "auto"))
    body = (str(st.get("text") or "").strip() or required or (fallback or "").strip())
    geom = {"used": False, "text": "", "top_px": 0, "bottom_px": 0, "bottom_pct": 0.0}
    if show == "never" or not body or (show == "auto" and not required):
        shutil.copyfile(src, out)
        return out, geom
    w, h = probe_size(src)
    png, x, y, ph = overlay_png(body, st, w, h, out_dir / f"{out.stem}.ov.png")
    dur = float(st.get("duration") or 0)
    en = f":enable='between(t,0,{dur:g})'" if dur > 0 else ""
    anim = str(st.get("anim") or "none")
    inputs = ["-i", str(src), "-loop", "1", "-i", str(png)]
    if anim == "slide":                                             # von oben hereinfahren (der Layer sitzt oben)
        fc = (f"[1:v]format=rgba,fade=t=in:st=0:d={ANIM_S}:alpha=1[ov];"
              f"[0:v][ov]overlay=x={x}:y='{y}-160*(1-{_ease()})'{en}[v]")
    elif anim == "fade":
        fc = f"[1:v]format=rgba,fade=t=in:st=0:d={ANIM_S}:alpha=1[ov];[0:v][ov]overlay=x={x}:y={y}{en}[v]"
    else:
        fc = f"[0:v][1:v]overlay=x={x}:y={y}{en}[v]"
    subprocess.run(["ffmpeg", "-y", *inputs, "-filter_complex", fc, "-map", "[v]", "-map", "0:a?", "-shortest",
                    "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", str(out)],
                   check=True, capture_output=True)
    geom = {"used": True, "text": body, "top_px": int(y), "bottom_px": int(y + ph), "bottom_pct": round((y + ph) / h * 100, 1)}
    return out, geom


def _hex_to_ffmpeg(c: str) -> str:
    return c.replace("#", "0x") if c.startswith("#") else c


DEFAULT_STYLE = {"font": "dejavu-bold", "color": "#FFFFFF", "outline_px": 5, "outline_color": "#000000", "accent_color": None,
                 "accent_mode": "bar", "box_color": None, "align": "center", "y_pct": 0.685, "max_lines": 2, "size_max": 72, "size_min": 36,
                 # Feinjustierung (settings.visual): size = px bei 1080 Breite, weight nur für variable Fonts
                 "size": None, "weight": None, "spacing": 0, "line_h": None, "x_pct": 50, "w_pct": 84, "case": "none",
                 "box": None, "box_opacity": 55, "box_pad": 10, "box_radius": 10, "shadow": 0, "anim": "none", "safe_right": SAFE_RIGHT, "safe_top": SAFE_TOP}


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
             visible_words: int | None = None, info: dict | None = None) -> tuple[Path, int, int]:
    """Hook-Text als PNG (pipeline/text.py). Rückgabe: (png, x, y) für ffmpeg overlay – Block um y_pct zentriert, nie unter 72 %.
    min_top (Kollisionsschutz): Oberkante, die das Overlay oben freihält – der Hook wird nach unten geschoben.
    `info` nimmt die Lage auf: gewünschtes y, tatsächliches y, wie weit geschoben, ob der Abstand trotzdem zu klein bleibt."""
    from pipeline import text as T
    st = _style(style)
    left, box_w = hook_box(st, width)
    max_h = int(height * 0.075) if not st.get("size") else int(height * 0.16)      # feste Größe: Block darf bis ~16 % hoch werden
    img = T.render(text, box_w, max_h, visible_words=visible_words, **_hook_render_args(st, text, accent_word, width))
    T.save(img, out)
    y_center = int(height * float(st["y_pct"]))
    y_cap = int(height * HOOK_MAX_Y) - img.height                                  # unterste erlaubte Lage (Safe-Zone unten)
    y_want = min(y_center - img.height // 2, y_cap)
    min_top = max(int(st.get("safe_top", SAFE_TOP)), int(st.get("min_top") or 0))
    y = max(y_want, min_top)
    if y > y_cap:                                                                  # Overlay drückt den Hook unter die Safe-Zone → dort halten
        y = y_cap
    if info is not None:
        info.update(height=img.height, y_wanted=int(y_want), y=int(y), moved=int(max(0, y - y_want)),
                    min_top=int(min_top), too_tight=bool(min_top > y_cap))
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


COVER_STYLE_DEFAULTS = {"mode": "hook", "text": "", "font": "Anton", "size": 92, "weight": 800, "color": "#FFFFFF",
                        "accent": "#FF6A00", "case": "upper", "align": "center", "y_pct": 45, "x_pct": 50, "w_pct": 78,
                        "max_words": 6, "lines": 3, "outline_px": 8, "shadow": 2, "box": "none", "box_color": "#000000",
                        "box_opacity": 55, "box_pad": 14, "box_radius": 14, "frame": "motion", "frame_skip_s": 1, "dim": 15}


def cover_style_from_visual(vis: dict) -> dict:
    """settings.visual.cover → Cover-Tokens. Das Cover erbt nichts mehr vom Hook, nur die Safe-Zones gelten weiter."""
    c = dict((vis or {}).get("cover") or {})
    st = {**COVER_STYLE_DEFAULTS, **{k: v for k, v in c.items() if v is not None}}
    if isinstance(st.get("box"), bool): st["box"] = "solid" if st["box"] else "none"
    st["safe_top"] = int((vis or {}).get("safe_top_px") or SAFE_TOP)
    st["safe_right"] = int((vis or {}).get("safe_right_px") or SAFE_RIGHT)
    return st


def _first_face_frame(src: Path, skip_s: float, window_s: float, step_s: float = 0.5) -> float | None:
    """Erster Zeitpunkt mit einem erkannten Gesicht (OpenCV-Haarcascade). None, wenn keins gefunden wird oder cv2 fehlt."""
    try:
        import cv2
    except Exception:
        return None
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if cascade.empty():
        return None
    cap = cv2.VideoCapture(str(src))
    try:
        t = float(skip_s)
        while t <= skip_s + window_s:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ok, frame = cap.read()
            if not ok:
                break
            small = cv2.resize(frame, (0, 0), fx=360 / max(1, frame.shape[1]), fy=360 / max(1, frame.shape[1]))
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            if len(cascade.detectMultiScale(gray, 1.15, 5, minSize=(40, 40))):
                return t
            t += step_s
    finally:
        cap.release()
    return None


def pick_cover_time(src: Path, st: dict, dur: float) -> float:
    """Standbild wählen: motion = größte Szenenänderung nach frame_skip_s, face = erster Frame mit Gesicht,
    first = erster Frame nach dem Übersprung, manual = später aus der Vorschau (bis dahin wie first).
    Fällt die Wahl aus, greift immer der erste Frame nach dem Übersprung."""
    skip = max(0.0, min(float(st.get("frame_skip_s", 1) or 0), max(0.0, dur - 0.5)))
    mode = str(st.get("frame") or "motion")
    at = float(st.get("frame_at") or 0) if mode == "manual" else 0.0
    if mode == "manual" and at > 0:
        return min(at, max(0.0, dur - 0.1))
    if mode == "face":
        t = _first_face_frame(src, skip, max(2.0, min(15.0, dur - skip)))
        if t is not None:
            return t
    if mode == "motion":
        t = best_motion_frame(src, max(1.0, dur / 3))
        if t >= skip:
            return t
    return skip


def cover_frame(src: Path, text: str, style: dict, accent_word: str | None, out_png: Path, out_jpg: Path | None = None,
                cover_style: dict | None = None) -> Path:
    """Cover (Standbild im Profil) nach eigenen Werten: Frame nach `frame`, Bild um `dim` % abgedunkelt, Text nach den
    Cover-Werten (Schrift, Größe, Dicke, Großschreibung, Ausrichtung, max. Wörter/Zeilen, Position, Breite, Farbe mit Akzent
    auf den letzten zwei Wörtern, Outline, Schatten, Box). mode = none → nur Bild.
    PNG für das Video (erster Frame), JPEG für R2/Blotato-Vorschau."""
    from PIL import Image
    from pipeline import text as T
    w, h = probe_size(src)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
                               capture_output=True, text=True).stdout.strip() or 10)
    cst = {**COVER_STYLE_DEFAULTS, **{k: v for k, v in (cover_style or {}).items() if v is not None}}
    tmp = out_png.with_suffix(".base.png")
    at = pick_cover_time(src, cst, dur)
    def grab(t: float) -> bool:
        r = subprocess.run(["ffmpeg", "-y", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", str(tmp)], capture_output=True)
        return r.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0
    if not grab(at):                                                  # Fallback: erster Frame nach dem Übersprung, sonst Sekunde 0
        skip = max(0.0, min(float(cst.get("frame_skip_s", 1) or 0), max(0.0, dur - 0.5)))
        if not grab(skip):
            grab(0.0)
    base = Image.open(tmp).convert("RGBA")
    dim = float(cst.get("dim", 0) or 0)
    if dim > 0:                                                       # Bild abdunkeln, damit der Text sicher lesbar bleibt
        base = Image.alpha_composite(base, Image.new("RGBA", base.size, (0, 0, 0, round(255 * min(60.0, dim) / 100))))
    mode = str(cst.get("mode") or "hook")
    body = (str(cst.get("text") or "").strip() if mode == "custom" else (text or "").strip()) or (text or "").strip()
    if mode != "none" and body:
        words = body.split()
        max_words = int(cst.get("max_words", 6) or 6)
        if len(words) > max_words:
            body = " ".join(words[:max_words]).rstrip(",;:–-") + "…"
        scale = w / 1080
        margin = 60
        hi = w - int(cst.get("safe_right", SAFE_RIGHT)) - margin
        box_w = max(200, min(int(w * float(cst.get("w_pct", 78)) / 100), hi - margin))
        toks = (body.upper() if str(cst.get("case")) == "upper" else body).split()
        accent_idx = {len(toks) - 2, len(toks) - 1} if len(toks) >= 2 else {0}      # Akzent auf den letzten zwei Wörtern
        img = T.render(body, box_w, int(h * 0.34),
                       font=str(cst.get("font") or "Anton").lower().replace(" ", "-"),
                       size_max=int(round(float(cst.get("size", 92)) * scale)), size_min=max(24, int(round(float(cst.get("size", 92)) * scale * 0.5))),
                       color=str(cst.get("color", "#FFFFFF")), outline_px=int(cst.get("outline_px", 8)), outline_color="#000000",
                       accent_color=str(cst.get("accent") or "") or None, accent_idx=accent_idx,
                       box=str(cst.get("box", "none")), box_color=str(cst.get("box_color", "#000000")),
                       box_opacity=float(cst.get("box_opacity", 55)), box_pad=int(round(float(cst.get("box_pad", 14)) * scale)),
                       box_radius=int(round(float(cst.get("box_radius", 14)) * scale)), align=str(cst.get("align", "center")),
                       max_lines=int(cst.get("lines", 3)), weight=cst.get("weight"), case=str(cst.get("case", "upper")),
                       shadow=int(cst.get("shadow", 2)))
        cx = int(w * float(cst.get("x_pct", 50)) / 100)
        left = max(margin, min(cx - box_w // 2, hi - box_w))
        if str(cst.get("align")) == "left": x = left
        elif str(cst.get("align")) == "right": x = left + box_w - img.width
        else: x = left + (box_w - img.width) // 2
        y = int(h * float(cst.get("y_pct", 45)) / 100) - img.height // 2
        y = max(int(cst.get("safe_top", SAFE_TOP)), min(y, h - int(SAFE_BOTTOM) - img.height))
        base.alpha_composite(img, (max(0, int(x)), max(0, int(y))))
    base.convert("RGB").save(out_png, "PNG")
    if out_jpg:
        base.convert("RGB").save(out_jpg, "JPEG", quality=88)
    tmp.unlink(missing_ok=True)
    void_accent = accent_word                                         # Akzentwort ist beim Cover fest auf die letzten zwei Wörter gelegt
    del void_accent, style
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


def _hook_filters(src: Path, text: str, st: dict, w: int, h: int, seconds: float, accent_word: str | None, out_dir: Path, stem: str,
                  info: dict | None = None) -> tuple[list[str], list[str], int]:
    """Baut Eingaben + filter_complex-Kette für den Hook-Text: Box (solid im PNG, blur per boxblur auf dem Video),
    Einblendung anim = none | pop (Scale 0.5→1) | slide (von unten) | typewriter (Wort für Wort). Rückgabe (inputs, filters, png_height).
    Der Kette liegt [0:v] an, sie endet in [hv]."""
    from PIL import Image
    en = f"enable='between(t,0,{seconds})'"
    png, x, y = hook_png(text, st, w, h, accent_word, out_dir / f"{stem}.hook.png", info=info)
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
                    cover: bool = True, ending: dict | None = None, cover_style: dict | None = None,
                    overlay_geom: dict | None = None) -> tuple[Path, Path | None, dict]:
    """Hook-Text (Zone 65–72 %, `seconds` s) + Cover-Frame als erster Frame (2 Frames, Blotato videoCoverTimestamp=0).
    style: 'bar' (A: weiß, Akzentbalken) | 'box' (B: Text auf Box) | dict mit Tokens aus config/brand.yaml / settings.visual.
    overlay_geom: Lage des oberen Overlays (aus apply) – der Hook hält 8 % der Höhe Abstand und rückt sonst nach unten.
    Rückgabe: (Video, Cover-JPEG oder None, QA-Vermerke). Ohne Text → Kopie."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (name or src.name)
    if not text or not text.strip():
        shutil.copyfile(src, out)
        return out, None, {}
    w, h = probe_size(src)
    if isinstance(style, dict):
        st = _style(style)
    elif style == "box":
        st = _style({"font": "dejavu-bold", "color": color, "box_color": accent, "accent_mode": "box", "align": "center"})
    else:
        st = _style({"font": "dejavu-bold", "color": color, "accent_color": accent, "accent_mode": "bar", "align": "center"})
    seconds = float(st.get("hook_seconds", seconds))
    ending = ending if ending is not None else st.get("ending")
    if overlay_geom and overlay_geom.get("used"):                      # Kollisionsschutz: 8 % der Höhe unter dem Overlay bleiben frei
        st["min_top"] = int(overlay_geom.get("bottom_px", 0)) + int(h * OVERLAY_HOOK_GAP)
    info: dict = {}
    extra_inputs, fc, _ = _hook_filters(src, text, st, w, h, seconds, accent_word, out_dir, out.stem, info=info)
    qa: dict = {}
    if info.get("moved"):
        qa["hook_moved_px"] = info["moved"]
        qa["notes"] = [f"Hook um {info['moved']} px nach unten geschoben (Mindestabstand {int(OVERLAY_HOOK_GAP * 100)} % zum Overlay oben)."]
    if info.get("too_tight"):
        qa.setdefault("notes", []).append("Overlay und Hook liegen enger als 8 % der Höhe – der Hook steht an der unteren Safe-Zone.")
        qa["overlap_risk"] = True
    inputs = ["-i", str(src), *extra_inputs]
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)], capture_output=True, text=True).stdout.strip() or 0)
    vf_end, af_end = _ending_filters(ending, dur)
    audio_src = "[0:a]"
    if vf_end:
        fc[-1] = fc[-1].replace("[hv]", "[he]") + f";[he]{vf_end}[hv];[0:a]{af_end}[ae]"
        audio_src = "[ae]"
    cover_jpg = None
    if cover:
        cover_png = cover_frame(src, text, st, accent_word, out_dir / f"{out.stem}.cover.png", out_dir / f"{out.stem}.cover.jpg",
                                cover_style=cover_style)
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
    return out, cover_jpg, qa


def frame(src: Path, out_path: Path, at: float = 1.0, width: int = 540) -> Path:
    """Standbild (JPEG) für die Telegram-Vorschau."""
    subprocess.run(["ffmpeg", "-y", "-ss", str(at), "-i", str(src), "-frames:v", "1", "-vf", f"scale={width}:-1", "-q:v", "4", str(out_path)],
                   check=True, capture_output=True)
    return out_path


def hook_type_of(clip: Path) -> str:
    """Grobe Klassifikation für die Wochenauswertung. V1: aus Dateinamen/Rank; später aus Manifest."""
    n = clip.name.lower()
    return "reaction" if "react" in n else "moment"
