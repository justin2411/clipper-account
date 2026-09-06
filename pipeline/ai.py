"""Kleine Gemini-Aufrufe der Pipeline (google-genai, GOOGLE_API_KEY): Hook-Satz für die Caption (≤12 Wörter),
kurzer Hook für den Text im Video (≤8 Wörter, vollständiger Satz) und Vorschlag für einen angepinnten Kommentar
(Frage, ≤15 Wörter). Zu lange Antworten werden nie mitten im Satz gekappt: erst Satz-/Klauselgrenze, sonst Fallback
auf die kürzere Variante. Fällt bei Fehlern auf den Titel zurück."""
import json, os, re

MODEL = os.environ.get("CLIPFORGE_GEMINI_MODEL", "gemini-2.5-flash")


def _words(s: str, n: int) -> str:
    w = str(s or "").strip().split()
    return " ".join(w[:n]).rstrip(",;:") if len(w) > n else " ".join(w)


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def fit_sentence(s: str, n: int) -> str:
    """Satz auf ≤ n Wörter bringen, ohne mitten im Satz abzubrechen: erster vollständiger Satz, sonst erste
    Klausel (bis , ; : – oder -) innerhalb des Limits, sonst leer (→ Aufrufer nimmt die kürzere Variante)."""
    s = _clean(s)
    if len(s.split()) <= n:
        return s
    m = re.match(r"^(.+?[.!?])(\s|$)", s)
    if m and len(m.group(1).split()) <= n:
        return m.group(1)
    best = ""
    for m in re.finditer(r"[,;:–-]\s", s):
        part = s[:m.start()].strip()
        if len(part.split()) <= n and len(part.split()) >= 3:
            best = part
    return best


def enrich(title: str, description: str, transcript: str, campaign_name: str) -> dict:
    """→ {"caption_hook": str, "pinned_comment": str}"""
    fallback = {"caption_hook": _words(description or title, 12), "overlay_hook": _words(title, 8), "pinned_comment": ""}
    key = os.environ.get("GOOGLE_API_KEY")
    if not key:
        return fallback
    try:
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=key)
        prompt = f"""You write TikTok captions for short clips from "{campaign_name}".
Clip title: {title}
Clip summary: {description}
Transcript excerpt: {transcript[:1200]}

Return JSON with exactly three fields:
- "caption_hook": ONE complete sentence for the caption, STRICTLY 12 words or fewer, opens with a question or tension, understandable without context, no hashtags, no emoji, no clickbait.
- "overlay_hook": a COMPLETE short phrase for on-screen text, STRICTLY 8 words or fewer (count them), same idea as caption_hook but shorter, no trailing cut-off, no hashtags, no emoji.
- "pinned_comment": ONE question (max 15 words) to pin as a comment that makes viewers answer or argue.
Never exceed the word limits; shorten the idea instead of cutting a sentence."""
        r = client.models.generate_content(model=MODEL, contents=prompt,
                                           config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.7))
        d = json.loads(r.text)
        overlay = fit_sentence(d.get("overlay_hook") or "", 8)
        caption = fit_sentence(d.get("caption_hook") or "", 12) or overlay
        overlay = overlay or fit_sentence(caption, 8)
        out = {"caption_hook": caption or fallback["caption_hook"],
               "overlay_hook": overlay or fallback["overlay_hook"],
               "pinned_comment": _clean(_words(d.get("pinned_comment") or "", 18))}
        return out
    except Exception as e:
        print("[ai] enrich failed:", str(e)[:120])
        return fallback
