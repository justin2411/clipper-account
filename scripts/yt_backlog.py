"""Backlog: alle Videos der vier MrBeast-Kanäle per yt-dlp (Flat-Playlist, ohne Download) mit Aufrufzahlen
in D1 speichern (POST /api/videos). Der Fan-Lauf im Worker arbeitet sie nach Aufrufen ab, Videos der letzten
30 Tage zuerst, sobald kein neues Video kommt und der Vorrat unter dem Soll liegt.
  python scripts/yt_backlog.py [--limit N] [--channel <id>]        (Env: CLIPFORGE_API_URL/KEY)"""
import argparse, json, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import db  # noqa: E402

CHANNELS = {
    "UCX6OQ3DkcsbYNE6H8uQQuVA": "MrBeast",
    "UCUaT_39o1x6qWjz7K2pWcgw": "Beast Reacts",
    "UC4-79UOlP48-QNGgCko5p2g": "MrBeast 2",
    "UCAiLfjNXkNv24uhpzUgPa6A": "Beast Philanthropy",
}


def list_channel(cid: str, limit: int) -> list[dict]:
    cmd = ["yt-dlp", "--flat-playlist", "-J", "--extractor-args", "youtubetab:approximate_date", f"https://www.youtube.com/channel/{cid}/videos"]
    if limit:
        cmd += ["--playlist-end", str(limit)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-300:])
    out = []
    for e in json.loads(r.stdout).get("entries") or []:
        if not e or not e.get("id"):
            continue
        ts = e.get("timestamp")
        published = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z") if ts else None
        dur = e.get("duration")
        out.append({"id": e["id"], "channel_id": cid, "channel_name": CHANNELS[cid], "title": e.get("title"),
                    "url": f"https://www.youtube.com/watch?v={e['id']}", "published_at": published,
                    "views": int(e.get("view_count") or 0), "duration_s": int(dur) if dur else None,
                    "is_short": 1 if dur and dur < 180 else 0, "source": "backlog"})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0); ap.add_argument("--channel", default="")
    a = ap.parse_args()
    total = 0
    for cid, name in CHANNELS.items():
        if a.channel and cid != a.channel:
            continue
        try:
            items = list_channel(cid, a.limit)
        except Exception as e:
            print(f"{name}: FEHLER {e}"); db.log(None, f"backlog_error {name}: {str(e)[:100]}"); continue
        for i in range(0, len(items), 200):
            db.post_videos(items[i:i + 200])
        total += len(items)
        recent = sum(1 for v in items if v["published_at"] and v["published_at"] >= datetime.now(timezone.utc).replace(day=1).isoformat())
        print(f"{name}: {len(items)} Videos ({sum(1 for v in items if v['is_short'])} kurz), Ø Views {sum(v['views'] for v in items) // max(1, len(items)):,}")
    print(f"gesamt: {total}")


if __name__ == "__main__":
    main()
