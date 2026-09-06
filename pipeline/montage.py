"""Automatische Montage: ein Clip aus 3–4 Stellen des Quellvideos, die zusammen eine Linie erzählen.

Aufbau (Rollen, Sekunden):
  1 Einsatz oder Frage   2–4    was auf dem Spiel steht
  2 Aufbau               5–10   gern von einer anderen Stelle des Videos
  3 Wendung              5–10   der Moment, an dem es kippt
  4 Reaktion/Auflösung   4–8    das längste Segment
Gesamt 22–35 s, harte Schnitte, keine Blenden. Die Segmente müssen mindestens 30 s auseinander liegen,
sonst ist es nur ein zerschnittener Ausschnitt. Gemini schreibt in einem Satz, welche Linie der Clip erzählt –
fehlt der Satz, ist die Auswahl falsch und der Clip wird verworfen.

Schnittrhythmus: kein Teil länger als 4 s ohne Wechsel. Wechsel ist entweder ein Punch-in (5–8 %, höchstens
zwei je Clip), ein Ausschnittswechsel (weit/nah aus demselben Bild) oder ein Schnitt an einer Wortgrenze.
Alle Schnitte liegen auf Wortgrenzen (Start −120 ms, Ende +250 ms), Stille über 0,6 s fliegt raus.

Kein Spiegeln, keine Geschwindigkeitsänderung, kein Rand-Beschnitt – nur Schnitt, Ausschnitt und Text.
"""
import json, os, re, subprocess
from pathlib import Path

MODEL = os.environ.get("CLIPFORGE_GEMINI_MODEL", "gemini-2.5-flash")

ROLES = [                                   # (Name, min_s, max_s, Beschreibung für das Modell)
    ("stakes", 2.0, 4.0, "the stake or the question: what is at risk"),
    ("build", 5.0, 10.0, "the build-up, preferably from a different part of the video"),
    ("turn", 5.0, 10.0, "the turn: the moment it tips"),
    ("payoff", 4.0, 8.0, "the reaction or resolution, the longest segment"),
]
TOTAL_MIN, TOTAL_MAX = 22.0, 35.0
MIN_APART_S = 30.0                          # Segmente müssen aus verschiedenen Teilen des Videos stammen
PART_MAX_S = 4.0                            # kein Teil länger als 4 s ohne Wechsel
PART_MIN_S = 1.0                            # kürzere Stücke wirken wie ein Ruckler, sie werden mit dem Nachbarn verschmolzen
PUNCH_MIN, PUNCH_MAX = 0.05, 0.08           # Punch-in 5–8 %
PUNCH_PER_CLIP = 2                          # mehr wirkt unruhig
NEAR_ZOOM = 0.15                            # Ausschnittswechsel weit → nah
SNAP_PRE, SNAP_POST = 0.12, 0.25            # Wortgrenzen: Start −120 ms, Ende +250 ms
SILENCE_MAX = 0.6                           # Stille darüber wird herausgeschnitten
SEAM_S = 0.03                               # 30 ms Audio-Crossfade an den Übergängen
HOOK_S = 3.0                                # Hook: erste 3 Sekunden, dann ausblenden
HOOK_MIN_PCT, HOOK_MAX_PCT = 12.0, 68.0
LOUDNORM = {"I": -14.0, "TP": -1.5, "LRA": 11.0}
OUT = {"w": 1080, "h": 1920, "fps": 30, "crf": 19, "gop": 60, "abr": "160k"}

PROMPT = """You build short vertical clips (TikTok) from one long video by MONTAGE: you pick 3-4 passages from
DIFFERENT parts of the video and put them in an order that tells one line.

TRANSCRIPT (seconds):
{transcript}

Video length: {duration:.0f} s.

Return JSON: {{"clips": [ {{"line": string, "hook_text": string, "context_line": string, "accent_word": string,
 "pinned_comment": string, "segments": [ {{"role": "stakes|build|turn|payoff", "start": number, "end": number,
 "why": string}} ] }} ]}}

Rules:
- Exactly {n} clips. Each clip has 3 or 4 segments in this order and length:
{roles}
- Total length of a clip: {tmin:.0f}-{tmax:.0f} seconds.
- The segments of one clip MUST come from different parts of the video: at least {apart:.0f} seconds between the
  start of one segment and the start of any other segment of the same clip. Never take one continuous passage.
- "line": ONE sentence saying which line this clip tells (setup, turn, payoff). If you cannot say it in one
  sentence, the selection is wrong - drop that clip and pick another one.
- Segment boundaries fall on sentence boundaries in the transcript, never mid-sentence.
- "hook_text": on-screen text, max 6 words, in YOUR OWN WORDS.
- "context_line": max 8 words, your own words, no phrase of 3+ words from the transcript.
- "accent_word": one word from context_line. "pinned_comment": one question, max 15 words.
- English. Only JSON."""


# ---------- Auswahl ----------

def _roles_text() -> str:
    return "\n".join(f"  {i+1}. {r[0]} ({r[1]:.0f}-{r[2]:.0f} s): {r[3]}" for i, r in enumerate(ROLES))


def validate(clip: dict, duration: float | None = None) -> tuple[bool, str]:
    """Prüft Rollen, Längen, Gesamtlänge, Abstand der Segmente und den Linien-Satz."""
    segs = clip.get("segments") or []
    if not (3 <= len(segs) <= 4):
        return False, f"{len(segs)} Segmente (3 oder 4 erwartet)"
    if not str(clip.get("line") or "").strip():
        return False, "kein Satz zur erzählten Linie"
    total = 0.0
    for i, s in enumerate(segs):
        try:
            a, b = float(s["start"]), float(s["end"])
        except (KeyError, TypeError, ValueError):
            return False, "Segment ohne Zeiten"
        if b <= a:
            return False, "Segment mit Ende vor Anfang"
        if duration and b > duration + 0.5:
            return False, "Segment hinter dem Videoende"
        role = str(s.get("role") or ROLES[min(i, len(ROLES) - 1)][0])
        spec = next((r for r in ROLES if r[0] == role), ROLES[min(i, len(ROLES) - 1)])
        if not (spec[1] - 0.5 <= b - a <= spec[2] + 0.5):
            return False, f"{role}: {b - a:.1f} s außerhalb {spec[1]:.0f}–{spec[2]:.0f} s"
        total += b - a
    if not (TOTAL_MIN - 1 <= total <= TOTAL_MAX + 1):
        return False, f"Gesamtlänge {total:.1f} s außerhalb {TOTAL_MIN:.0f}–{TOTAL_MAX:.0f} s"
    starts = sorted(float(s["start"]) for s in segs)
    for a, b in zip(starts, starts[1:]):
        if b - a < MIN_APART_S:
            return False, f"Segmente nur {b - a:.0f} s auseinander (mindestens {MIN_APART_S:.0f} s)"
    return True, "ok"


def select(transcript: str, duration: float, n: int = 6) -> list[dict]:
    """Gemini wählt Montagen. Was die Regeln nicht erfüllt, fliegt hier raus – lieber weniger Clips."""
    key = os.environ.get("GOOGLE_API_KEY")
    if not key:
        print("[montage] GOOGLE_API_KEY fehlt – keine Auswahl")
        return []
    prompt = PROMPT.format(transcript=transcript[:60000], duration=duration, n=n, roles=_roles_text(),
                           tmin=TOTAL_MIN, tmax=TOTAL_MAX, apart=MIN_APART_S)
    try:
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=key)
        r = client.models.generate_content(model=MODEL, contents=prompt,
                                           config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.7))
        data = json.loads(r.text)
    except Exception as e:
        print("[montage] Auswahl fehlgeschlagen:", str(e)[:160])
        return []
    out = []
    for c in (data.get("clips") or []):
        ok, why = validate(c, duration)
        if not ok:
            print(f"[montage] verworfen: {why} · {str(c.get('line'))[:60]}")
            continue
        c["segments"] = sorted(c["segments"], key=lambda s: ROLES.index(next((r[0] for r in ROLES if r[0] == s.get("role")), "build")))
        out.append(c)
    return out


# ---------- Schnittplan ----------

def snap(a: float, b: float, words: list[dict]) -> tuple[float, float]:
    """Schnitt auf Wortgrenzen: Start = Wortanfang −120 ms, Ende = Wortende +250 ms."""
    if not words:
        return a, b
    starts = [float(w["start"]) for w in words]
    ends = [float(w["end"]) for w in words]
    ws = min(starts, key=lambda x: abs(x - a))
    cand = [e for e in ends if e <= b + 0.35]
    we = max(cand) if cand else b
    if we <= ws + 0.5:
        later = [e for e in ends if e > ws + 0.5]
        we = later[0] if later else b
    return max(0.0, round(ws - SNAP_PRE, 3)), round(we + SNAP_POST, 3)


def drop_silence(a: float, b: float, words: list[dict], max_gap: float = SILENCE_MAX) -> list[tuple[float, float]]:
    """Stille über max_gap herausschneiden: das Segment zerfällt in Teile, die an Wortgrenzen anschließen."""
    inner = [w for w in words if float(w["end"]) > a and float(w["start"]) < b]
    if not inner:
        return [(a, b)]
    parts, start = [], a
    for w1, w2 in zip(inner, inner[1:]):
        gap = float(w2["start"]) - float(w1["end"])
        if gap > max_gap:
            parts.append((start, round(float(w1["end"]) + SNAP_POST, 3)))
            start = round(max(a, float(w2["start"]) - SNAP_PRE), 3)
    parts.append((start, b))
    return [(s, e) for s, e in parts if e - s >= PART_MIN_S]      # Schnipsel unter 1 s bringen nichts


def split_parts(a: float, b: float, words: list[dict], max_len: float = PART_MAX_S) -> list[tuple[float, float]]:
    """Teile von höchstens 4 s, Trennstellen auf Wortgrenzen (ein Schnitt zählt selbst als Wechsel)."""
    if b - a <= max_len:
        return [(a, b)]
    ends = [float(w["end"]) for w in words if a < float(w["end"]) < b]
    parts, start = [], a
    while b - start > max_len:
        rest = b - start
        ziel = start + (rest / 2 if rest < max_len + PART_MIN_S else max_len)   # Rest gleichmäßig teilen, kein Schnipsel am Ende
        passend = [e for e in ends if start + PART_MIN_S < e <= ziel + 0.4 and b - e >= PART_MIN_S]
        cut = max(passend) if passend else ziel
        parts.append((round(start, 3), round(cut, 3)))
        start = round(cut, 3)
    parts.append((round(start, 3), round(b, 3)))
    return parts


def plan(clip: dict, words: list[dict]) -> dict:
    """Segmente → Teile mit Ausschnitt (weit/nah/punch). Höchstens zwei Punch-ins je Clip."""
    parts, punches = [], 0
    for i, seg in enumerate(clip["segments"]):
        a, b = snap(float(seg["start"]), float(seg["end"]), words)
        for (sa, sb) in drop_silence(a, b, words):
            stuecke = split_parts(sa, sb, words)
            for j, (pa, pb) in enumerate(stuecke):
                if j == 0:
                    frame = "wide" if i % 2 == 0 else "near"          # Ausschnittswechsel zwischen den Segmenten
                elif punches < PUNCH_PER_CLIP:
                    frame = "punch"; punches += 1                      # Punch-in als Wechsel innerhalb des Segments
                else:
                    frame = "near" if stuecke[j - 1] and j % 2 else "wide"
                parts.append({"start": round(pa, 3), "end": round(pb, 3), "frame": frame, "role": seg.get("role", "")})
    total = sum(p["end"] - p["start"] for p in parts)
    return {**clip, "parts": parts, "punches": punches, "total_s": round(total, 2)}


# ---------- Rendern ----------

def probe(path: Path) -> tuple[int, int, float]:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height:format=duration", "-of", "json", str(path)], capture_output=True, text=True)
    d = json.loads(r.stdout or "{}")
    st = (d.get("streams") or [{}])[0]
    return int(st.get("width") or 1920), int(st.get("height") or 1080), float((d.get("format") or {}).get("duration") or 0)


def _crop_chain(w: int, h: int, frame: str) -> str:
    """9:16-Ausschnitt aus dem Quellbild; weit = voller Bildausschnitt, nah/punch = enger, ohne Rand-Beschnitt."""
    zoom = {"wide": 1.0, "punch": 1.0 + (PUNCH_MIN + PUNCH_MAX) / 2, "near": 1.0 + NEAR_ZOOM}.get(frame, 1.0)
    cw = min(w, int(h * 9 / 16))                                   # größtmögliches 9:16-Fenster
    cw2, ch2 = int(cw / zoom), int(h / zoom)
    cw2 -= cw2 % 2; ch2 -= ch2 % 2
    return (f"crop={cw2}:{ch2}:(iw-{cw2})/2:(ih-{ch2})/2,scale={OUT['w']}:{OUT['h']}:flags=lanczos,"
            f"setsar=1,fps={OUT['fps']},format=yuv420p")


def build_cuts(src: Path, plan_: dict, out: Path) -> Path:
    """Teile schneiden und hart aneinandersetzen; 30 ms Audio-Crossfade an den Nähten, kein Bild-Übergang.
    Je Teil eine eigene Eingabe mit -ss/-to: ffmpeg springt dann direkt an die Stelle, statt das Quellvideo
    für jeden Teil von vorn zu dekodieren – bei einer 40-Minuten-Quelle ist das der Unterschied zwischen
    Minuten und Stunden."""
    w, h, dur = probe(src)
    parts = plan_["parts"]
    inputs, fc, vlabels = [], [], []
    for i, p in enumerate(parts):
        a, b = float(p["start"]), min(float(p["end"]), dur)
        ae = min(b + (SEAM_S if i < len(parts) - 1 else 0.0), dur)      # Naht: 30 ms mehr Ton für den Crossfade
        inputs += ["-ss", f"{max(0.0, a - 2.0):.3f}", "-i", str(src)]   # 2 s Vorlauf: sauberer Einstieg am Keyframe
        vor = min(2.0, a)
        fc.append(f"[{i}:v]trim=start={vor:.3f}:end={vor + (b - a):.3f},setpts=PTS-STARTPTS,{_crop_chain(w, h, p['frame'])}[v{i}]")
        fc.append(f"[{i}:a]atrim=start={vor:.3f}:end={vor + (ae - a):.3f},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a{i}]")
        vlabels.append(f"[v{i}]")
    fc.append(f"{''.join(vlabels)}concat=n={len(parts)}:v=1:a=0[vc]")
    if len(parts) == 1:
        fc.append("[a0]anull[ac]")
    else:
        cur = "[a0]"
        for i in range(1, len(parts)):
            lbl = "[ac]" if i == len(parts) - 1 else f"[ax{i}]"
            fc.append(f"{cur}[a{i}]acrossfade=d={SEAM_S}:c1=tri:c2=tri{lbl}")
            cur = lbl
    subprocess.run(["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(fc), "-map", "[vc]", "-map", "[ac]",
                    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", str(out)], check=True, capture_output=True)
    return out


def measure_loudness(path: Path) -> dict | None:
    """Erster Durchgang des zweistufigen loudnorm."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path), "-af",
                        f"loudnorm=I={LOUDNORM['I']}:TP={LOUDNORM['TP']}:LRA={LOUDNORM['LRA']}:print_format=json",
                        "-f", "null", "-"], capture_output=True, text=True)
    m = re.findall(r"\{[^{}]*\"input_i\"[\s\S]*?\}", r.stderr)
    try:
        return json.loads(m[-1]) if m else None
    except Exception:
        return None


def loudnorm_filter(measured: dict | None) -> str:
    base = f"loudnorm=I={LOUDNORM['I']}:TP={LOUDNORM['TP']}:LRA={LOUDNORM['LRA']}"
    if not measured:
        return base
    return (f"{base}:measured_I={measured.get('input_i')}:measured_TP={measured.get('input_tp')}:"
            f"measured_LRA={measured.get('input_lra')}:measured_thresh={measured.get('input_thresh')}:"
            f"offset={measured.get('target_offset', 0)}:linear=true:print_format=summary")


def finish(cut: Path, out: Path, ass: Path | None, hook_png: Path | None, hook_xy: tuple[int, int] | None,
           measured: dict | None, fonts_dir: Path | None = None) -> Path:
    """Zweiter Durchgang: Untertitel einbrennen, Hook für 3 s, Ton normalisieren, Ausgabeformat setzen."""
    vf, inputs = [], ["-i", str(cut)]
    idx = 1
    if hook_png and hook_xy:
        inputs += ["-loop", "1", "-t", f"{HOOK_S:.2f}", "-i", str(hook_png)]
    fc = []
    cur = "[0:v]"
    if hook_png and hook_xy:
        x, y = hook_xy
        fc.append(f"[{idx}:v]format=rgba,fade=t=out:st={HOOK_S - 0.4:.2f}:d=0.4:alpha=1[hk];"
                  f"{cur}[hk]overlay=x={x}:y={y}:enable='between(t,0,{HOOK_S:.2f})'[vh]")
        cur = "[vh]"; idx += 1
    if ass:
        esc = str(ass).replace(":", "\\:").replace("'", "\\'")
        f = f"subtitles='{esc}'" + (f":fontsdir='{fonts_dir}'" if fonts_dir else "")
        fc.append(f"{cur}{f}[vs]")
        cur = "[vs]"
    fc.append(f"{cur}format=yuv420p[vout]")
    subprocess.run(["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(fc), "-map", "[vout]", "-map", "0:a",
                    "-af", loudnorm_filter(measured), "-c:v", "libx264", "-crf", str(OUT["crf"]), "-preset", "medium",
                    "-pix_fmt", "yuv420p", "-r", str(OUT["fps"]), "-g", str(OUT["gop"]), "-keyint_min", str(OUT["gop"]),
                    "-sc_threshold", "0", "-c:a", "aac", "-b:a", OUT["abr"], "-ar", "48000",
                    "-movflags", "+faststart", str(out)], check=True, capture_output=True)
    void = vf
    del void
    return out


def stills(clip: Path, out_dir: Path, n: int = 3) -> list[Path]:
    """Drei Standbilder (Anfang, Mitte, Ende) für die Bildprüfung."""
    _, _, dur = probe(clip)
    out = []
    for i, frac in enumerate((0.15, 0.5, 0.85)[:n]):
        p = out_dir / f"{clip.stem}.qa{i + 1}.jpg"
        subprocess.run(["ffmpeg", "-y", "-ss", f"{dur * frac:.2f}", "-i", str(clip), "-frames:v", "1",
                        "-q:v", "4", str(p)], check=True, capture_output=True)
        out.append(p)
    return out


def quality(clip: Path, plan_: dict, has_subs: bool, work: Path) -> dict:
    """Prüfung vor der Freigabe: drei Standbilder an Gemini plus die automatischen Prüfungen.
    Fällt eine durch, gehört der Clip nicht in die Freigabe, sondern mit Begründung in die Vorschau."""
    from pipeline import ai
    notes: list[str] = []
    auto = {
        "linie": bool(str(plan_.get("line") or "").strip()),
        "verschiedene_stellen": True,
        "untertitel": bool(has_subs),
    }
    starts = sorted(float(s["start"]) for s in plan_.get("segments", []))
    for a, b in zip(starts, starts[1:]):
        if b - a < MIN_APART_S:
            auto["verschiedene_stellen"] = False
    if not auto["linie"]:
        notes.append("Kein Satz zur erzählten Linie – die Auswahl trägt nicht.")
    if not auto["verschiedene_stellen"]:
        notes.append("Segmente liegen zu dicht beieinander, das ist ein zerschnittener Ausschnitt.")
    if not auto["untertitel"]:
        notes.append("Keine Untertitel: im Clip wird nicht gesprochen oder das Transkript fehlt.")
    bilder = []
    try:
        bilder = [p.read_bytes() for p in stills(clip, work)]
    except Exception as e:
        notes.append(f"Standbilder nicht erstellt: {str(e)[:80]}")
    urteil = ai.judge_stills(bilder, str(plan_.get("hook_text") or ""), has_subs)
    notes += [n for n in urteil.get("notes") or [] if n]
    checks = {**auto, **urteil.get("checks", {})}
    ok = all(auto.values()) and urteil.get("ok", True)
    score = round(10.0 * sum(1 for v in checks.values() if v) / max(1, len(checks)), 1)
    return {"ok": ok, "score": score, "checks": checks, "notes": notes[:6]}


def render_clip(src: Path, clip: dict, words: list[dict], out: Path, work: Path, account: str = "A",
                hook_style: dict | None = None, sub_style: dict | None = None) -> dict:
    """Ganzer Weg für einen Montage-Clip: Schnittplan, Rohschnitt, Untertitel, Hook, Ton, Ausgabe, Prüfung."""
    from pipeline import overlay as OV, subtitles as SUB
    work.mkdir(parents=True, exist_ok=True)
    plan_ = plan(clip, words)

    # Wörter der Teile auf die Zeitachse des fertigen Clips umrechnen (die Teile stehen jetzt hintereinander)
    neu: list[dict] = []
    versatz = 0.0
    for p in plan_["parts"]:
        a, b = float(p["start"]), float(p["end"])
        for w in words:
            ws, we = float(w["start"]), float(w["end"])
            if we > a and ws < b:
                neu.append({"word": w.get("word", ""), "start": max(0.0, ws - a) + versatz, "end": min(b - a, we - a) + versatz})
        versatz += b - a

    cut = build_cuts(src, plan_, work / f"{out.stem}.cut.mp4")
    _, _, dur = probe(cut)
    ass = SUB.write_ass(neu, work / f"{out.stem}.ass", OUT["w"], OUT["h"], account, sub_style, duration=dur)

    hook_png = hook_xy = None
    hook_text = str(clip.get("hook_text") or clip.get("context_line") or "").strip()
    if hook_text:
        st = {**(hook_style or {}), "box": "none", "color": (hook_style or {}).get("color", "#FFFFFF"),
              "outline_px": (hook_style or {}).get("outline_px", 5)}
        oben = SUB.top_of_subtitles(OUT["h"])                       # Hook rückt nach oben, wenn er die Untertitel treffen würde
        y_pct = min(HOOK_MAX_PCT, max(HOOK_MIN_PCT, float(st.get("hook_y_pct", 60))))
        st["hook_y_pct"] = y_pct
        png, x, y = OV.hook_png(hook_text, st, OUT["w"], OUT["h"], clip.get("accent_word"), work / f"{out.stem}.hook.png")
        from PIL import Image
        hoehe = Image.open(png).height
        if y + hoehe > oben:
            y = max(int(OUT["h"] * HOOK_MIN_PCT / 100), oben - hoehe - 12)
        hook_png, hook_xy = png, (x, y)

    measured = measure_loudness(cut)
    fonts = Path(__file__).resolve().parent.parent / "assets" / "fonts"
    finish(cut, out, ass, hook_png, hook_xy, measured, fonts if fonts.is_dir() else None)
    qa = quality(out, {**plan_, "hook_text": hook_text}, bool(ass), work)
    w2, h2, dur2 = probe(out)
    return {"path": str(out), "plan": plan_, "duration_s": round(dur2, 2), "size": f"{w2}x{h2}",
            "subtitles": bool(ass), "hook": hook_text, "qa": qa,
            "loudness": {"vorher": measured.get("input_i") if measured else None, "ziel": LOUDNORM["I"]}}
