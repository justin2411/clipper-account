"""Schnitt, Audio, Encoding (Stufe 4) auf dem fertigen Clip des Clippers:
  • Stille > 0,6 s trimmen (ffmpeg silencedetect → trim/concat), nie am Anfang
  • Punch-in: max. 2 pro Clip an Lautheits-Spitzen (A 8 %, B 6 %), Ease-in 0,4 s, vorher 2× hochskaliert gegen Jitter
  • Loudnorm zweistufig (Pass 1 messen, Pass 2 I=-14 TP=-1.5 LRA=11 linear mit measured_*)
  • Encoding libx264 CRF 19, yuv420p, 30 fps, GOP 60, AAC 160k 48 kHz, faststart
Die Schnittpunkte auf Wortgrenzen (Start −120 ms, Ende +250 ms) setzt pipeline/moments.py vor dem Render."""
import json, re, subprocess
from pathlib import Path

ENC = ["-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", "30", "-g", "60", "-keyint_min", "60",
       "-sc_threshold", "0", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart"]


def duration(p: Path) -> float:
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                                capture_output=True, text=True).stdout.strip() or 0)


def silences(p: Path, min_s: float = 0.6, noise: str = "-35dB") -> list[tuple[float, float]]:
    r = subprocess.run(["ffmpeg", "-v", "info", "-i", str(p), "-af", f"silencedetect=n={noise}:d={min_s}", "-f", "null", "-"],
                       capture_output=True, text=True)
    out, start = [], None
    for line in r.stderr.splitlines():
        m = re.search(r"silence_start: ([\d.]+)", line)
        if m: start = float(m.group(1))
        m = re.search(r"silence_end: ([\d.]+)", line)
        if m and start is not None: out.append((start, float(m.group(1)))); start = None
    return out


def keep_segments(dur: float, sil: list[tuple[float, float]], keep_pad: float = 0.15, min_gap: float = 0.6) -> list[tuple[float, float]]:
    """Behaltene Abschnitte: Stille > min_gap wird auf keep_pad×2 gekürzt; Stille am Anfang bleibt (Cold Open nicht anfassen)."""
    segs, cur = [], 0.0
    for s, e in sil:
        if s <= 0.05:                                   # Stille ganz am Anfang: nicht trimmen
            continue
        if e - s <= min_gap:
            continue
        cut_from, cut_to = s + keep_pad, e - keep_pad
        if cut_to - cut_from < 0.2:
            continue
        segs.append((cur, cut_from)); cur = cut_to
    segs.append((cur, dur))
    return [(a, b) for a, b in segs if b - a > 0.05]


def loudness_peaks(p: Path, n: int = 2, min_gap: float = 3.0, skip_start: float = 1.0, skip_end: float = 1.5) -> list[float]:
    """Zeitpunkte der n höchsten Momentan-Lautheiten (ebur128, 400 ms Fenster) mit Mindestabstand."""
    r = subprocess.run(["ffmpeg", "-v", "info", "-i", str(p), "-af", "ebur128=peak=none", "-f", "null", "-"], capture_output=True, text=True)
    pts = []
    for line in r.stderr.splitlines():
        m = re.search(r"t:\s*([\d.]+)\s+.*?M:\s*(-?[\d.]+)", line)
        if m: pts.append((float(m.group(1)), float(m.group(2))))
    dur = duration(p)
    cands = sorted([(l, t) for t, l in pts if skip_start <= t <= dur - skip_end and l > -70], reverse=True)
    out: list[float] = []
    for _, t in cands:
        if all(abs(t - o) >= min_gap for o in out):
            out.append(t)
        if len(out) >= n: break
    return sorted(out)


def punch_expr(peaks: list[float], pct: float, ease: float = 0.4, hold: float = 1.2, release: float = 0.3) -> str:
    """Zoomfaktor z(t): 1 → 1+pct mit quadratischem Ease-in über `ease` s, halten, dann linear zurück."""
    if not peaks:
        return "1"
    terms = []
    for T in peaks:
        a, b, c = T, T + ease, T + ease + hold
        terms.append(f"if(between(t,{a:.3f},{b:.3f}),pow((t-{a:.3f})/{ease},2),if(between(t,{b:.3f},{c:.3f}),1,if(between(t,{c:.3f},{c + release:.3f}),1-(t-{c:.3f})/{release},0)))")
    return f"1+{pct}*min(1,{'+'.join(terms)})"


def measure_loudness(p: Path) -> dict:
    r = subprocess.run(["ffmpeg", "-v", "info", "-i", str(p), "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    return json.loads(m.group(0)) if m else {}


def process(src: Path, out: Path, punch_pct: float = 0.08, width: int = 1080, height: int = 1920) -> dict:
    """Stille trimmen → Punch-ins → Loudnorm (2 Pässe) → Encoding. Rückgabe: Kennzahlen für Log/QA."""
    out.parent.mkdir(parents=True, exist_ok=True)
    dur = duration(src)
    segs = keep_segments(dur, silences(src))
    trimmed = out.with_name(out.stem + ".trim.mp4")
    if len(segs) > 1:
        fc = "".join(f"[0:v]trim={a:.3f}:{b:.3f},setpts=PTS-STARTPTS[v{i}];[0:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS[a{i}];" for i, (a, b) in enumerate(segs))
        fc += "".join(f"[v{i}][a{i}]" for i in range(len(segs))) + f"concat=n={len(segs)}:v=1:a=1[v][a]"
        subprocess.run(["ffmpeg", "-y", "-i", str(src), "-filter_complex", fc, "-map", "[v]", "-map", "[a]", *ENC, str(trimmed)], check=True, capture_output=True)
    else:
        trimmed = src
    peaks = loudness_peaks(trimmed, n=2)
    z = punch_expr(peaks, punch_pct)
    meas = measure_loudness(trimmed)
    af = "loudnorm=I=-14:TP=-1.5:LRA=11:linear=true"
    if meas.get("input_i"):
        af += f":measured_I={meas['input_i']}:measured_TP={meas['input_tp']}:measured_LRA={meas['input_lra']}:measured_thresh={meas['input_thresh']}:offset={meas.get('target_offset', 0)}"
    af += ",aresample=48000"
    vf = (f"scale={width * 2}:{height * 2}:flags=lanczos,crop=w=iw/({z}):h=ih/({z}):x=(iw-ow)/2:y=(ih-oh)/2,scale={width}:{height}:flags=lanczos"
          if peaks else f"scale={width}:{height}")
    subprocess.run(["ffmpeg", "-y", "-i", str(trimmed), "-vf", vf, "-af", af, *ENC, str(out)], check=True, capture_output=True)
    if trimmed != src:
        trimmed.unlink(missing_ok=True)
    return {"duration_in": round(dur, 2), "duration_out": round(duration(out), 2), "segments": len(segs), "punch_at": [round(t, 2) for t in peaks],
            "loudness_in": meas.get("input_i")}
