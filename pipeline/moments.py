"""Momentwahl mit Bewertungsraster (Stufe 3) – ersetzt die Gemini-Analyse des Vendors (Monkeypatch in clipper.py).
Gemini bekommt das Transkript mit Zeitstempeln und liefert 20 Kandidaten à 15–35 s, je 0–2 Punkte auf
Überraschung, sichtbarer Einsatz, Reaktion, Cliffhanger, ohne Kontext verständlich, Klarheit in Sekunde 1,
dazu hook_text, context_line (eigene Worte, ≤8 Wörter), accent_word, pinned_comment.
Dedupe bei >50 % Überlappung, Top N (Standard 8) werden gerendert; Rang 1,3,5… → A, 2,4,6… → B (pipeline/main.py)."""
import json, os, re
from pathlib import Path

MODEL = os.environ.get("CLIPFORGE_GEMINI_MODEL", "gemini-2.5-flash")
CANDIDATES, MIN_S, MAX_S = 20, 15.0, 35.0
CRITERIA = ["surprise", "stakes", "reaction", "cliffhanger", "standalone", "clarity"]

PROMPT = """You select the best moments of a long YouTube video for vertical short clips (TikTok, 15-35 s each).
The transcript has timestamps in seconds: "[start - end] text".

TRANSCRIPT:
{transcript}

Return JSON: {{"candidates": [ {{"start": number, "end": number, "hook_text": string, "context_line": string,
 "accent_word": string, "pinned_comment": string,
 "scores": {{"surprise": 0-2, "stakes": 0-2, "reaction": 0-2, "cliffhanger": 0-2, "standalone": 0-2, "clarity": 0-2}} }} ]}}

Rules:
- Exactly {n} candidates, spread over the whole video, each {min_s}-{max_s} seconds long.
- COLD OPEN: "start" is the beginning of the strongest sentence of the moment (never mid-sentence, no teaser, no jump back);
  "end" is right after the payoff/punchline plus ~0.3 s.
- Scores are integers 0, 1 or 2: surprise (unexpected twist), stakes (money/risk/consequence visible), reaction (strong
  human reaction), cliffhanger (viewer must know what happens next), standalone (understandable without the full video),
  clarity (what is happening is clear within the first second).
- "hook_text": on-screen text, max 6 words, punchy, in YOUR OWN WORDS.
- "context_line": ONE line in YOUR OWN WORDS, max 8 words, gives the viewer the context of this moment, creates
  tension or curiosity, no quotation marks, no emoji, no hashtags, and it must NOT reuse any phrase of 3+ consecutive
  words from the transcript.
- "accent_word": exactly one word from context_line that carries the most weight (a number, a stake, the twist).
- "pinned_comment": one question (max 15 words) that makes viewers answer or argue.
- English. No clickbait lies. Only JSON."""


def _parse_transcript_lines(transcript: str) -> list[tuple[float, float, str]]:
    out = []
    for m in re.finditer(r"\[(\d+(?:\.\d+)?) - (\d+(?:\.\d+)?)\]\s*(.*)", transcript):
        out.append((float(m.group(1)), float(m.group(2)), m.group(3).strip()))
    return out


def snippet(transcript: str, start: float, end: float) -> str:
    return " ".join(t for s, e, t in _parse_transcript_lines(transcript) if e > start and s < end)


def overlap_ratio(a: tuple[float, float], b: tuple[float, float]) -> float:
    inter = max(0.0, min(a[1], b[1]) - max(a[0], b[0]))
    shorter = max(0.1, min(a[1] - a[0], b[1] - b[0]))
    return inter / shorter


def dedupe(cands: list[dict], max_overlap: float = 0.5) -> list[dict]:
    kept: list[dict] = []
    for c in sorted(cands, key=lambda x: (-x["total"], x["start"])):
        if all(overlap_ratio((c["start"], c["end"]), (k["start"], k["end"])) <= max_overlap for k in kept):
            kept.append(c)
    return kept


def _clean_candidates(raw: list, video_dur: float | None) -> list[dict]:
    out = []
    for c in raw or []:
        try:
            s, e = float(c.get("start")), float(c.get("end"))
        except (TypeError, ValueError):
            continue
        if e <= s:
            continue
        if e - s > MAX_S:
            e = s + MAX_S
        if e - s < MIN_S:
            e = s + MIN_S
        if video_dur and e > video_dur:
            e = video_dur
            if e - s < MIN_S:
                continue
        sc = {k: max(0, min(2, int(float((c.get("scores") or {}).get(k, 0) or 0)))) for k in CRITERIA}
        line = re.sub(r"\s+", " ", str(c.get("context_line") or "")).strip().strip("\"'“”")
        out.append({"start": round(s, 2), "end": round(e, 2), "hook_text": str(c.get("hook_text") or "").strip(),
                    "context_line": line, "accent_word": str(c.get("accent_word") or "").strip(),
                    "pinned_comment": str(c.get("pinned_comment") or "").strip(), "scores": sc, "total": sum(sc.values())})
    return out


def analyze(transcript: str, cfg, out_dir: Path | None = None, top_n: int | None = None) -> list[dict]:
    """Drop-in für engine.analyze_with_ai: → Liste im Vendor-Format (rank, start_time, end_time, hook, …) + unsere Felder."""
    from google import genai
    from google.genai import types
    n = int(top_n or getattr(cfg, "jumlah_clip", 8) or 8)
    lines = _parse_transcript_lines(transcript)
    video_dur = max((e for _, e, _ in lines), default=None)
    client = genai.Client(api_key=getattr(cfg, "api_key_gemini", None) or os.environ.get("GOOGLE_API_KEY"))
    prompt = PROMPT.format(transcript=transcript[:180000], n=CANDIDATES, min_s=int(MIN_S), max_s=int(MAX_S))
    cands: list[dict] = []
    for attempt in range(2):
        r = client.models.generate_content(model=MODEL, contents=prompt,
                                           config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.5 + 0.2 * attempt))
        try:
            data = json.loads(r.text)
        except Exception:
            data = {}
        cands = _clean_candidates(data.get("candidates") if isinstance(data, dict) else data, video_dur)
        if len(cands) >= max(3, n):
            break
    kept = dedupe(cands)[:n]
    items = []
    for i, c in enumerate(kept, 1):
        items.append({
            "rank": i, "viral_score": c["total"], "start_time": c["start"], "end_time": c["end"],
            "hook": {"text": c["hook_text"], "start_time": c["start"], "end_time": min(c["end"], c["start"] + 2.0)},
            "title_inggris": c["hook_text"] or c["context_line"], "title_indonesia": "",
            "description_hook": c["context_line"], "description_context": "", "hastag": "", "keyword_tags": [],
            "typography_plan": [], "broll_list": [], "keep_segments": [{"start_time": c["start"], "end_time": c["end"]}],
            "context_line": c["context_line"], "accent_word": c["accent_word"], "pinned_comment": c["pinned_comment"],
            "scores": {**c["scores"], "total": c["total"]}, "transcript_text": snippet(transcript, c["start"], c["end"]),
        })
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "moments.json").write_text(json.dumps({"candidates": cands, "selected": [x["rank"] for x in items]}, indent=1, ensure_ascii=False))
    print(f"[moments] {len(cands)} Kandidaten → {len(kept)} nach Dedupe/Top-{n}: " + ", ".join(f"#{x['rank']} {x['start_time']:.0f}-{x['end_time']:.0f}s ({x['viral_score']})" for x in items))
    return items
