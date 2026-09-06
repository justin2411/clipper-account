"""Fortschritt und Lebenszeichen des Clip-Jobs an den Worker (POST /api/progress).

Der Punkt ist die Unterscheidung „arbeitet" gegen „tot": ein Hintergrund-Faden meldet alle 30 Sekunden den Stand
der laufenden Stufe. Bleibt die Meldung zehn Minuten aus, zeigt das Dashboard „hängt" statt „läuft"; nach zwei
Stunden räumt der Cron die Zeile auf failed.

Prozent gibt es nur, wo sie echt sind:
  • Transkript – verarbeitete Länge gegen die Spieldauer der Quelle (faster-whisper liefert Segmente fortlaufend)
  • Schnitt/Render – ffmpeg -progress (out_time_us) gegen die Zielspieldauer
Momentwahl und QA melden keinen Wert; dort zeigt das Dashboard „läuft seit 3 min (üblich 2–4 min)".
"""
import os, subprocess, threading, time
import requests

URL = os.environ.get("CLIPFORGE_API_URL", "").rstrip("/")
KEY = os.environ.get("CLIPFORGE_API_KEY", "")
RUN_ID = os.environ.get("GITHUB_RUN_ID") or None
BEAT_S = 30

_state = {"campaign": None, "upload": None, "stage": None, "progress": None, "detail": None, "account": None}
_lock = threading.Lock()
_thread = None
_stop = threading.Event()


def _post(body):
    if not URL or not KEY:
        return None
    try:
        r = requests.post(f"{URL}/api/progress", json=body, timeout=20,
                          headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        return r.json() if r.ok and r.content else None
    except Exception as e:                                     # ein verpasstes Lebenszeichen darf den Job nie stoppen
        print("progress failed:", str(e)[:120]); return None


def _send(status="running"):
    with _lock:
        s = dict(_state)
    if not s["stage"] or not (s["campaign"] or s["upload"]):
        return None
    return _post({"campaign_id": s["campaign"], "upload_id": s["upload"], "stage": s["stage"], "status": status,
                  "progress": s["progress"], "detail": s["detail"], "run_id": RUN_ID, "account": s["account"]})


def _beat():
    while not _stop.wait(BEAT_S):
        _send()


def start(campaign_id, account=None, upload_id=None):
    """Lebenszeichen-Faden starten (einmal je Lauf). Er endet mit dem Prozess."""
    global _thread
    with _lock:
        _state.update(campaign=campaign_id, account=account, upload=upload_id)
    if _thread is None:
        _thread = threading.Thread(target=_beat, daemon=True)
        _thread.start()
    return _thread


def stage(name, progress=None, detail=None):
    """Neue Stufe (download | transcript | moments | cut | render | qa). Meldet sofort und dann alle 30 s weiter."""
    with _lock:
        _state.update(stage=name, progress=progress, detail=detail)
    return _send()


def update(progress=None, detail=None):
    """Stand innerhalb der laufenden Stufe – ohne eigenen Netzaufruf, der Faden nimmt ihn beim nächsten Takt mit."""
    with _lock:
        if progress is not None:
            _state["progress"] = max(0.0, min(1.0, float(progress)))
        if detail is not None:
            _state["detail"] = str(detail)[:120]


def tick(progress=None, detail=None):
    """Wie update(), meldet aber sofort – für Schritte, die selten, aber sichtbar vorankommen."""
    update(progress, detail)
    return _send()


def done(note=None):
    return _finish("done", note)


def failed(note=None):
    return _finish("failed", note)


def _finish(status, note):
    with _lock:
        s = dict(_state)
    if not s["stage"]:
        return None
    r = _post({"campaign_id": s["campaign"], "upload_id": s["upload"], "stage": s["stage"], "status": status,
               "progress": 1.0 if status == "done" else s["progress"], "detail": s["detail"],
               "run_id": RUN_ID, "account": s["account"], "note": (str(note)[:200] if note else None)})
    with _lock:
        _state["stage"] = None if status != "done" else s["stage"]
        _state["progress"] = None
    return r


def stop():
    _stop.set()


def run_ffmpeg(cmd, total_s, on=None):
    """ffmpeg mit -progress: out_time_us gegen die Zielspieldauer → echter Prozentwert.
    `cmd` ist die fertige ffmpeg-Zeile ohne -progress; total_s ist die erwartete Länge der Ausgabe."""
    full = list(cmd)
    ins = 1 if full and full[0] == "ffmpeg" else 0
    full[ins:ins] = ["-progress", "pipe:1", "-nostats"]
    p = subprocess.Popen(full, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    last = 0.0
    for line in p.stdout:
        # out_time=HH:MM:SS.mmm ist eindeutig; out_time_ms fuehrt in ffmpeg trotz des Namens Mikrosekunden.
        if line.startswith("out_time="):
            t = line.split("=", 1)[1].strip()
            try:
                h, m, sec_ = t.split(":")
                sec = int(h) * 3600 + int(m) * 60 + float(sec_)
            except ValueError:
                continue
            if total_s and sec >= last:
                last = sec
                frac = max(0.0, min(1.0, sec / float(total_s)))
                (on or update)(frac, f"{sec:.0f} von {float(total_s):.0f} s")
    err = p.stderr.read()
    code = p.wait()
    if code != 0:
        # Die Ursache steht in ffmpegs stderr, nicht im Kommando - sonst steht im Ereignis-Log nur die Zeile,
        # mit der es nicht geklappt hat, und man raet, warum.
        letzte = " | ".join(z.strip() for z in (err or "").strip().splitlines()[-4:])
        raise RuntimeError(f"ffmpeg (exit {code}): {letzte[-400:]}")
    return code
