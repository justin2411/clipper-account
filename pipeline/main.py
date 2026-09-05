"""Schwerer Job (GitHub Actions): Footage → Clips → Overlay → Checks → R2 → D1 (über Worker-API).
Clips landen nach den Checks als 'ready'; der Publisher postet sie automatisch zu den Slots. Telegram informiert nur.
Aufruf: python -m pipeline.main --campaign <id> --account A
Env: CLIPFORGE_API_URL, CLIPFORGE_API_KEY, GOOGLE_API_KEY (Gemini für die Momentwahl im Clipper)
"""
import argparse, re, sys, yaml
from pathlib import Path
from pipeline import download, overlay, checks, storage, db, clipper
from platforms import REGISTRY

ROOT = Path(__file__).resolve().parent.parent
WORK = Path("work").resolve(); WORK.mkdir(exist_ok=True)


def load_yaml(p): return yaml.safe_load(Path(p).read_text())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--campaign", required=True); ap.add_argument("--account", required=True)
    a = ap.parse_args()

    campaign = db.get_campaign(a.campaign)
    accounts_cfg = load_yaml(ROOT / "config/accounts.yaml")
    acct = next(x for x in accounts_cfg["accounts"] if x["id"] == a.account)
    max_clips = int(accounts_cfg.get("max_clips_per_source", clipper.DEFAULT_MAX_CLIPS))
    platform = REGISTRY[campaign["platform"]]
    rules = platform.rules(campaign)

    sources = download.fetch(campaign["footage"], WORK / "src")
    if not sources:
        db.log(a.campaign, f"footage_missing account={a.account}"); sys.exit(0)
    db.log(a.campaign, f"footage_ok account={a.account} files={len(sources)} bytes={sum(s.stat().st_size for s in sources)}")

    raw_clips: list[tuple[int, Path, str]] = []       # (Quell-Index, Clip, Hook-Satz)
    for i, src in enumerate(sources):
        try:
            clips = clipper.run(src, acct["clipper_flags"], WORK / a.account / f"src{i}",
                                label_url=campaign["footage"].get("url", ""), max_clips=max_clips)
        except Exception as e:                        # eine kaputte Quelle bricht den Job nicht ab
            db.log(a.campaign, f"clipper_error account={a.account} src={src.name} err={str(e)[:120]}"); continue
        db.log(a.campaign, f"clipper_done account={a.account} src={src.name} raw={len(clips)}")
        hooks = clipper.hooks_of(WORK / a.account / f"src{i}")
        raw_clips += [(i, c, hooks.get(re.search(r"rank_(\d+)", c.name).group(1), "")) for c in clips]
    caption = platform.caption(campaign)
    kept = 0
    overlay_text = (campaign.get("required") or {}).get("overlay_text") or ""
    for i, clip, hook in raw_clips:
        final = overlay.apply(clip, overlay_text, WORK / "final", name=f"s{i}_{clip.name}")
        ok, reason = checks.validate(final, rules, forbidden=campaign.get("forbidden", {}))
        dur = checks.duration_of(final)
        if not ok:
            db.insert_clip(a.campaign, a.account, str(final), status="rejected_precheck", note=reason, duration_s=dur, hook=hook); continue
        url = storage.upload(final, prefix=f"{a.campaign}/{a.account}")
        db.insert_clip(a.campaign, a.account, url, status="ready", caption=caption,
                       hook_type=overlay.hook_type_of(clip), duration_s=dur, hook=hook)
        kept += 1
    db.log(a.campaign, f"pipeline_done account={a.account} kept={kept}/{len(raw_clips)}")
    db.notify(f"✂️ Clip-Job fertig: {campaign['name']} – Account {a.account}: {kept} Clips bereit (von {len(raw_clips)} geschnitten). "
              f"Publisher postet sie zu den nächsten Slots.")


if __name__ == "__main__":
    main()
