"""Kleine Gemini-Aufrufe der Pipeline (google-genai, GOOGLE_API_KEY): Hook-Satz für die Caption (≤12 Wörter)
und Vorschlag für einen angepinnten Kommentar (Frage, ≤15 Wörter). Fällt bei Fehlern auf den Titel zurück."""
import json, os, re

MODEL = os.environ.get("CLIPFORGE_GEMINI_MODEL", "gemini-2.5-flash")


def _words(s: str, n: int) -> str:
    w = str(s or "").strip().split()
    return " ".join(w[:n]).rstrip(",;:") if len(w) > n else " ".join(w)


def enrich(title: str, description: str, transcript: str, campaign_name: str) -> dict:
    """→ {"caption_hook": str, "pinned_comment": str}"""
    fallback = {"caption_hook": _words(description or title, 12), "pinned_comment": ""}
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

Return JSON with exactly two fields:
- "caption_hook": ONE sentence for the caption, MAX 12 words, opens with a question or tension, understandable without context, no hashtags, no emoji, no clickbait.
- "pinned_comment": ONE question (max 15 words) to pin as a comment that makes viewers answer or argue."""
        r = client.models.generate_content(model=MODEL, contents=prompt,
                                           config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.7))
        d = json.loads(r.text)
        out = {"caption_hook": _words(d.get("caption_hook") or fallback["caption_hook"], 12),
               "pinned_comment": _words(d.get("pinned_comment") or "", 18)}
        out["pinned_comment"] = re.sub(r"\s+", " ", out["pinned_comment"]).strip()
        return out if out["caption_hook"] else fallback
    except Exception as e:
        print("[ai] enrich failed:", str(e)[:120])
        return fallback
