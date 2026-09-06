"""Gemini-Aufrufe der Pipeline (google-genai, GOOGLE_API_KEY).
enrich(): Originalität pro Clip – eine Kontextzeile in EIGENEN Worten (≤8 Wörter, kein Zitat aus dem Transkript),
die als Hook-Text ins Bild und als erster Satz der Caption geht; dazu ein Akzentwort und eine Kommentar-Frage.
Zitate werden per 4-Wort-Fenster gegen das Transkript geprüft; bei Treffer ein zweiter Versuch, sonst Fallback."""
import json, os, re

MODEL = os.environ.get("CLIPFORGE_GEMINI_MODEL", "gemini-2.5-flash")
MAX_WORDS = 8


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def _words(s: str, n: int) -> str:
    w = _clean(s).split()
    return " ".join(w[:n]).rstrip(",;:") if len(w) > n else " ".join(w)


def _norm_tokens(s: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", (s or "").lower())


def quotes_transcript(line: str, transcript: str, n: int = 4) -> bool:
    """True, wenn ein Fenster aus n aufeinanderfolgenden Wörtern der Zeile wörtlich im Transkript vorkommt."""
    a, t = _norm_tokens(line), " ".join(_norm_tokens(transcript))
    if len(a) < n:
        return len(a) >= 3 and " ".join(a) in t
    return any(" ".join(a[i:i + n]) in t for i in range(len(a) - n + 1))


def fit_sentence(s: str, n: int) -> str:
    """Satz auf ≤ n Wörter, ohne mitten im Satz abzubrechen: erster vollständiger Satz, sonst erste Klausel, sonst leer."""
    s = _clean(s)
    if len(s.split()) <= n:
        return s
    m = re.match(r"^(.+?[.!?])(\s|$)", s)
    if m and len(m.group(1).split()) <= n:
        return m.group(1)
    best = ""
    for m in re.finditer(r"[,;:–-]\s", s):
        part = s[:m.start()].strip()
        if 3 <= len(part.split()) <= n:
            best = part
    return best


def _pick_accent(line: str) -> str:
    ws = [w.strip(".,!?\"'") for w in line.split()]
    for w in ws:                                         # Zahlen/Beträge zuerst, dann Großbuchstaben, sonst längstes Wort
        if re.search(r"\d", w):
            return w
    caps = [w for w in ws if len(w) > 2 and w.isupper()]
    return caps[0] if caps else max(ws, key=len, default="")


def enrich(title: str, description: str, transcript: str, campaign_name: str) -> dict:
    """→ {context_line, accent_word, caption_hook, overlay_hook, pinned_comment}"""
    fb_line = _words(title or description, MAX_WORDS)
    fallback = {"context_line": fb_line, "accent_word": _pick_accent(fb_line), "caption_hook": fb_line, "overlay_hook": fb_line, "pinned_comment": ""}
    key = os.environ.get("GOOGLE_API_KEY")
    if not key:
        return fallback
    try:
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=key)
        base = f"""You write on-screen text for a short vertical clip from "{campaign_name}".
Clip title: {title}
Clip summary: {description}
Transcript excerpt (for understanding only – NEVER quote it): {transcript[:1500]}

Return JSON with exactly three fields:
- "context_line": ONE line in YOUR OWN WORDS that gives the viewer the context of this moment in {MAX_WORDS} words or fewer
  (count them). It must be understandable without watching the video, create tension or curiosity, and must NOT reuse any
  phrase of 3+ consecutive words from the transcript. No hashtags, no emoji, no quotation marks, no clickbait lies.
- "accent_word": exactly one word from context_line that carries the most weight (a number, a stake, the twist).
- "pinned_comment": ONE question (max 15 words) to pin as a comment that makes viewers answer or argue.
Never exceed the word limit; shorten the idea instead of cutting a sentence."""
        stricter = "\n\nYour previous answer quoted the transcript or was too long. Rephrase completely in your own words, max 8 words."
        line, accent, pinned = "", "", ""
        for attempt in range(2):
            r = client.models.generate_content(model=MODEL, contents=base + (stricter if attempt else ""),
                                               config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.8 if attempt else 0.6))
            d = json.loads(r.text)
            cand = _clean(d.get("context_line") or "").strip("\"'“”")
            pinned = pinned or _clean(_words(d.get("pinned_comment") or "", 18))
            if cand and len(cand.split()) <= MAX_WORDS and not quotes_transcript(cand, transcript):
                line, accent = cand, _clean(d.get("accent_word") or "")
                break
            if cand and len(cand.split()) > MAX_WORDS:
                short = fit_sentence(cand, MAX_WORDS)
                if short and not quotes_transcript(short, transcript):
                    line, accent = short, _clean(d.get("accent_word") or ""); break
        if not line:
            print("[ai] context_line: Fallback (Zitat/zu lang)")
            line = fb_line
        if not accent or accent.lower().strip(".,!?\"'") not in [w.lower().strip(".,!?\"'") for w in line.split()]:
            accent = _pick_accent(line)
        return {"context_line": line, "accent_word": accent, "caption_hook": line, "overlay_hook": line, "pinned_comment": pinned}
    except Exception as e:
        print("[ai] enrich failed:", str(e)[:120])
        return fallback


def judge_stills(images: list[bytes], hook: str, subtitles: bool) -> dict:
    """Qualitätsprüfung mit Gemini an drei Standbildern: Hook lesbar, Gesicht frei, Text im sicheren Bereich,
    Schnitt nicht hektisch. Rückgabe {ok, checks:{...}, notes:[...]}. Ohne Schlüssel oder bei Fehlern: bestanden
    mit Hinweis – die automatischen Prüfungen greifen weiterhin."""
    key = os.environ.get("GOOGLE_API_KEY")
    if not key or not images:
        return {"ok": True, "checks": {}, "notes": ["Bildprüfung übersprungen (kein Schlüssel oder keine Bilder)"]}
    try:
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=key)
        frage = f"""These are three stills from one vertical TikTok clip (1080x1920), in order: beginning, middle, end.
On-screen hook text (first 3 seconds): "{hook}". Burned-in subtitles: {"yes" if subtitles else "no"}.

Return JSON: {{"hook_legible": bool, "face_free": bool, "text_safe": bool, "pacing_ok": bool, "notes": [string]}}
- hook_legible: is the hook text readable against the background (contrast, not cut off)?
- face_free: is a face visible and NOT covered by text or graphics? true if no face is expected in the shot.
- text_safe: is all text inside the safe area (not under the TikTok buttons on the right, not in the bottom 15 %)?
- pacing_ok: do the three stills look like one coherent clip rather than a hectic, jumpy edit?
- notes: one short sentence per problem, in German. Empty if everything is fine."""
        parts = [types.Part.from_bytes(data=b, mime_type="image/jpeg") for b in images[:3]]
        r = client.models.generate_content(model=MODEL, contents=[*parts, frage],
                                           config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.2))
        d = json.loads(r.text)
        checks = {k: bool(d.get(k, True)) for k in ("hook_legible", "face_free", "text_safe", "pacing_ok")}
        notes = [str(x) for x in (d.get("notes") or [])][:4]
        return {"ok": all(checks.values()), "checks": checks, "notes": notes}
    except Exception as e:
        print("[ai] Bildprüfung fehlgeschlagen:", str(e)[:120])
        return {"ok": True, "checks": {}, "notes": [f"Bildprüfung nicht möglich: {str(e)[:80]}"]}
