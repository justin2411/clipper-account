"""Text-Rendering für Hook-Text und Cover (Pillow → transparentes PNG, per ffmpeg overlay eingeblendet).
Vorteile gegenüber drawtext: echte Umbruchlogik, Outline in px, Akzentwort in eigener Farbe, Box, Links-/Zentriert."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = {"anton": ROOT / "assets/fonts/Anton-Regular.ttf", "bangers": ROOT / "assets/fonts/Bangers-Regular.ttf",
         "bebas-neue": ROOT / "assets/fonts/BebasNeue-Regular.ttf", "luckiest-guy": ROOT / "assets/fonts/LuckiestGuy-Regular.ttf",
         "montserrat": ROOT / "assets/fonts/Montserrat-Variable.ttf",
         "dejavu-bold": Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")}


def font_path(name: str) -> str:
    p = FONTS.get((name or "dejavu-bold").lower(), Path(name))
    return str(p if p.exists() else FONTS["dejavu-bold"])


def load_font(name: str, size: int) -> ImageFont.FreeTypeFont:
    """Font laden; variable Fonts (Montserrat) auf ExtraBold stellen."""
    f = ImageFont.truetype(font_path(name), size)
    try:
        names = [n.decode() if isinstance(n, bytes) else n for n in f.get_variation_names()]
        for want in ("ExtraBold", "Black", "Bold"):
            if want in names:
                f.set_variation_by_name(want); break
    except Exception:
        pass
    return f


def _wrap_balanced(words: list[str], font: ImageFont.FreeTypeFont, max_w: int, max_lines: int) -> list[str] | None:
    """Zeilen so, dass jede ≤ max_w ist; bei 2 Zeilen möglichst gleich lang. None, wenn es nicht passt."""
    def w(s: str) -> float: return font.getlength(s)
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
    return best[1] if best else None


def render(text: str, max_width: int, max_height: int, font: str = "dejavu-bold", size_max: int = 80, size_min: int = 36,
           color: str = "#FFFFFF", outline_px: int = 5, outline_color: str = "#000000", accent_word: str | None = None,
           accent_color: str | None = None, box_color: str | None = None, box_pad: int = 18, align: str = "center",
           max_lines: int = 2, line_gap: float = 0.12) -> Image.Image:
    """Rendert `text` (≤ max_lines Zeilen, automatische Größe) in ein RGBA-Bild. Akzentwort in accent_color."""
    words = [w for w in (text or "").split() if w]
    if not words:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    for size in range(size_max, size_min - 1, -2):
        f = load_font(font, size)
        lines = _wrap_balanced(words, f, max_width - 2 * box_pad - 2 * outline_px, max_lines)
        if not lines:
            continue
        line_h = int(size * (1 + line_gap))
        total_h = line_h * len(lines) + 2 * box_pad
        if total_h <= max_height:
            break
    else:   # Mindestgröße: Wörter abschneiden, bis es passt
        f = load_font(font, size_min)
        while words and not (lines := _wrap_balanced(words, f, max_width - 2 * box_pad - 2 * outline_px, max_lines)):
            words = words[:-1]
        if not words:
            return Image.new("RGBA", (1, 1), (0, 0, 0, 0))
        lines[-1] = lines[-1].rstrip(",;:") + "…"
        size = size_min; line_h = int(size * (1 + line_gap)); total_h = line_h * len(lines) + 2 * box_pad
    widths = [f.getlength(l) for l in lines]
    img_w = int(max(widths) + 2 * box_pad + 2 * outline_px) if align == "center" else max_width
    img = Image.new("RGBA", (max(img_w, 2), max(total_h + 2 * outline_px, 2)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    acc = (accent_word or "").strip().lower().strip(".,!?\"'")
    for i, line in enumerate(lines):
        lw = widths[i]
        x0 = (img.width - lw) / 2 if align == "center" else box_pad + outline_px
        y = outline_px + box_pad + i * line_h
        if box_color:
            d.rounded_rectangle([x0 - box_pad, y - box_pad * 0.35, x0 + lw + box_pad, y + line_h + box_pad * 0.15], radius=10, fill=box_color)
        x = x0
        for j, word in enumerate(line.split(" ")):
            token = word + (" " if j < len(line.split(" ")) - 1 else "")
            fill = accent_color if (accent_color and acc and word.lower().strip(".,!?\"'") == acc) else color
            d.text((x, y), token, font=f, fill=fill, stroke_width=outline_px, stroke_fill=outline_color)
            x += f.getlength(token)
    return img


def save(img: Image.Image, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG")
    return path
