"""Text-Rendering für Hook-Text und Cover (Pillow → transparentes PNG, per ffmpeg overlay eingeblendet).
Vorteile gegenüber drawtext: echte Umbruchlogik, Outline in px, Akzentwort in eigener Farbe, Box mit Deckkraft/Radius,
Buchstabenabstand, Schatten, variable Schriftdicke (wght-Achse), Links/Zentriert/Rechts.

Alle Werte aus settings.visual (Dashboard → Feinjustierung) laufen über `render(...)`:
  size (px bei 1080 breit, wird nur verkleinert, wenn der Text sonst nicht in max_lines passt), weight (400–900, nur variable Fonts),
  spacing (Buchstabenabstand px), line_h (Faktor), align, case (upper|none), box (none|solid|blur) + box_color/box_opacity/box_pad/box_radius,
  shadow (0–6), accent_idx (Wort-Indizes in Akzentfarbe), visible_words (Typewriter: nur die ersten n Wörter zeichnen)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = {"anton": ROOT / "assets/fonts/Anton-Regular.ttf", "bangers": ROOT / "assets/fonts/Bangers-Regular.ttf",
         "bebas-neue": ROOT / "assets/fonts/BebasNeue-Regular.ttf", "luckiest-guy": ROOT / "assets/fonts/LuckiestGuy-Regular.ttf",
         "montserrat": ROOT / "assets/fonts/Montserrat-Variable.ttf", "oswald": ROOT / "assets/fonts/Oswald-Variable.ttf",
         "archivo-black": ROOT / "assets/fonts/ArchivoBlack-Regular.ttf",
         "dejavu-bold": Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")}


def font_key(name: str) -> str:
    """'Bebas Neue' / 'bebas_neue' / 'BebasNeue' → 'bebas-neue'."""
    s = (name or "dejavu-bold").strip().lower().replace("_", " ").replace("-", " ")
    s = "-".join(s.split())
    if s in FONTS:
        return s
    compact = s.replace("-", "")
    for k in FONTS:
        if k.replace("-", "") == compact:
            return k
    return s


def font_path(name: str) -> str:
    p = FONTS.get(font_key(name), Path(name or ""))
    return str(p if p.exists() else FONTS["dejavu-bold"])


def load_font(name: str, size: int, weight: int | None = None) -> ImageFont.FreeTypeFont:
    """Font laden; variable Fonts (Montserrat, Oswald) auf `weight` stellen (Standard: ExtraBold/Bold)."""
    f = ImageFont.truetype(font_path(name), max(8, int(size)))
    try:
        axes = f.get_variation_axes()
        if axes:
            ax = axes[0]
            if weight:
                f.set_variation_by_axes([max(ax["minimum"], min(ax["maximum"], int(weight)))])
            else:
                names = [n.decode() if isinstance(n, bytes) else n for n in f.get_variation_names()]
                for want in ("ExtraBold", "Black", "Bold"):
                    if want in names:
                        f.set_variation_by_name(want); break
    except Exception:
        pass
    return f


def text_len(font: ImageFont.FreeTypeFont, s: str, spacing: float = 0) -> float:
    if not spacing:
        return font.getlength(s)
    return sum(font.getlength(ch) for ch in s) + spacing * max(0, len(s) - 1)


def _draw(d: ImageDraw.ImageDraw, x: float, y: float, s: str, font: ImageFont.FreeTypeFont, fill, stroke: int, stroke_fill, spacing: float = 0) -> float:
    """Zeichnet `s` ab (x, y), gibt die gezeichnete Breite zurück."""
    if not spacing:
        d.text((x, y), s, font=font, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
        return font.getlength(s)
    # Buchstabenabstand: zeichenweise, erst alle Outlines, dann alle Füllungen (sonst überdeckt die Outline den Nachbarn)
    for pass_fill in (False, True):
        cx = x
        for ch in s:
            if pass_fill:
                d.text((cx, y), ch, font=font, fill=fill)
            elif stroke:
                d.text((cx, y), ch, font=font, fill=stroke_fill, stroke_width=stroke, stroke_fill=stroke_fill)
            cx += font.getlength(ch) + spacing
    return text_len(font, s, spacing)


def _wrap_balanced(words: list[str], font: ImageFont.FreeTypeFont, max_w: int, max_lines: int, spacing: float = 0) -> list[str] | None:
    """Zeilen so, dass jede ≤ max_w ist; bei 2 Zeilen möglichst gleich lang. None, wenn es nicht passt."""
    def w(s: str) -> float: return text_len(font, s, spacing)
    text = " ".join(words)
    if w(text) <= max_w:
        return [text]
    if max_lines < 2:
        return None
    best = None
    for k in range(1, len(words)):
        a, b = " ".join(words[:k]), " ".join(words[k:])
        if w(a) <= max_w and w(b) <= max_w:
            score = abs(w(a) - w(b))
            if best is None or score < best[0]:
                best = (score, [a, b])
    if best or max_lines < 3:
        return best[1] if best else None
    # 3+ Zeilen: gierig füllen
    out, cur = [], ""
    for wd in words:
        if cur and w(f"{cur} {wd}") > max_w:
            out.append(cur); cur = wd
        else:
            cur = f"{cur} {wd}".strip()
    if cur: out.append(cur)
    return out if len(out) <= max_lines and all(w(l) <= max_w for l in out) else None


def _rgba(hex_color: str | None, opacity: float = 100) -> tuple[int, int, int, int]:
    h = (hex_color or "#000000").lstrip("#")
    if len(h) == 3: h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return r, g, b, max(0, min(255, round(255 * float(opacity) / 100)))


def render(text: str, max_width: int, max_height: int, font: str = "dejavu-bold", size_max: int = 80, size_min: int = 36,
           color: str = "#FFFFFF", outline_px: int = 5, outline_color: str = "#000000", accent_word: str | None = None,
           accent_color: str | None = None, box_color: str | None = None, box_pad: int = 18, align: str = "center",
           max_lines: int = 2, line_gap: float = 0.12, weight: int | None = None, spacing: float = 0, line_h: float | None = None,
           case: str = "none", box: str | None = None, box_opacity: float = 100, box_radius: int = 10, shadow: int = 0,
           accent_idx: set[int] | None = None, visible_words: int | None = None) -> Image.Image:
    """Rendert `text` (≤ max_lines Zeilen) in ein RGBA-Bild. Schrift startet bei size_max und wird nur verkleinert, wenn der Text
    sonst nicht in max_width × max_height passt. Akzentwörter (accent_idx oder accent_word) in accent_color."""
    if case == "upper":
        text = (text or "").upper()
    words = [w for w in (text or "").split() if w]
    if not words:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    box = box or ("solid" if box_color else "none")
    if box == "none":
        box_pad = min(box_pad, 6)          # ohne Box nur minimaler Innenabstand
    outline_px = int(outline_px); spacing = float(spacing or 0)
    lh_factor = float(line_h) if line_h else 1 + line_gap
    inner_w = max_width - 2 * box_pad - 2 * outline_px
    size = max(size_min, size_max)
    f = load_font(font, size, weight)
    lines = None
    for size in range(int(size_max), int(size_min) - 1, -2):
        f = load_font(font, size, weight)
        lines = _wrap_balanced(words, f, inner_w, max_lines, spacing)
        if not lines:
            continue
        line_px = int(size * lh_factor)
        total_h = line_px * len(lines) + 2 * box_pad
        if total_h <= max_height:
            break
    else:   # Mindestgröße: Wörter abschneiden, bis es passt
        f = load_font(font, size_min, weight)
        while words and not (lines := _wrap_balanced(words, f, inner_w, max_lines, spacing)):
            words = words[:-1]
        if not words:
            return Image.new("RGBA", (1, 1), (0, 0, 0, 0))
        lines[-1] = lines[-1].rstrip(",;:") + "…"
        size = size_min; line_px = int(size * lh_factor); total_h = line_px * len(lines) + 2 * box_pad
    widths = [text_len(f, l, spacing) for l in lines]
    img_w = int(max(widths) + 2 * box_pad + 2 * outline_px) if align == "center" else max_width
    pad_s = shadow * 3
    img = Image.new("RGBA", (max(img_w + pad_s, 2), max(total_h + 2 * outline_px + pad_s, 2)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Akzent-Indizes: explizit oder erstes Wort, das accent_word entspricht
    strip = lambda s: s.lower().strip(".,!?\"'’“”:;")
    if accent_idx is None:
        acc = strip(accent_word or "")
        accent_idx = set()
        if acc and accent_color:
            for i, w in enumerate(words):
                if strip(w) == acc:
                    accent_idx.add(i); break
    if not accent_color:
        accent_idx = set()
    # Boxen (Zeile für Zeile), Schattenebene, Text
    shadow_layer = Image.new("RGBA", img.size, (0, 0, 0, 0)) if shadow else None
    sd = ImageDraw.Draw(shadow_layer) if shadow_layer else None
    box_fill = _rgba(box_color or "#000000", box_opacity if box == "solid" else min(box_opacity, 45)) if box != "none" else None
    def x_of(i: int) -> float:
        lw = widths[i]
        if align == "center": return (img_w - lw) / 2
        if align == "right": return img_w - lw - box_pad - outline_px
        return box_pad + outline_px
    if box_fill:                                   # eine Box um den ganzen Block
        xs = [x_of(i) for i in range(len(lines))]
        left, right = min(xs) - box_pad, max(xs[i] + widths[i] for i in range(len(lines))) + box_pad
        top = outline_px + box_pad * 0.5
        bottom = outline_px + box_pad + len(lines) * line_px + box_pad * 0.2
        d.rounded_rectangle([left, top, right, bottom], radius=int(box_radius), fill=box_fill)
    idx = 0
    for i, line in enumerate(lines):
        lw = widths[i]
        x0 = x_of(i)
        y = outline_px + box_pad + i * line_px
        x = x0
        toks = line.split(" ")
        for j, word in enumerate(toks):
            token = word + (" " if j < len(toks) - 1 else "")
            visible = visible_words is None or idx < visible_words
            fill = accent_color if idx in accent_idx else color
            if visible:
                if sd is not None:
                    _draw(sd, x + shadow, y + shadow * 1.5, token, f, (0, 0, 0, 170), outline_px, (0, 0, 0, 170), spacing)
                _draw(d, x, y, token, f, fill, outline_px, outline_color, spacing)
            x += text_len(f, token, spacing) + (spacing if spacing and j < len(toks) - 1 else 0)
            idx += 1
    if shadow_layer is not None:
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=max(1, shadow)))
        out = Image.alpha_composite(shadow_layer, img)
        return out
    return img


def save(img: Image.Image, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG")
    return path
