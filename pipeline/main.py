"""Schwerer Job (GitHub Actions): Footage → Clips → Overlay → Checks → R2 → D1 (über Worker-API).
Aufruf: python -m pipeline.main --campaign <id> --account A
Env: CLIPFORGE_API_URL, CLIPFORGE_API_KEY, GOOGLE_API_KEY (Gemini für die Momentwahl im Clipper)
"""
import argparse, sys, yaml
from pathlib import Path
from pipeline import download, overlay, checks, storage, db, clipper
from platforms import REGISTRY

ROOT = Path(__file__).resolve().parent.parent
WORK = Path("work"); WORK.mkdir(exist_ok=True)


def load_yaml(p): return yaml.safe_load(Path(p).read_text())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--campaign", required=True); ap.add_argument("--account", required=True)
    a = ap.parse_args()

    campaign = db.get_campaign(a.campaign)
    acct = next(x for x in load_yaml(ROOT / "config/accounts.yaml")["accounts"] if x["id"] == a.account)
    platform = REGISTRY[campaign["platform"]]
    rules = platform.rules(campaign)

    src = download.fetch(campaign["footage"], WORK / "src")
    if src is None:
        db.log(a.campaign, f"footage_missing account={a.account}"); sys.exit(0)
    db.log(a.campaign, f"footage_ok account={a.account} file={src.name} bytes={src.stat().st_size}")

    raw_clips = clipper.run(src, acct["clipper_flags"], WORK / a.account, label_url=campaign["footage"].get("url", ""))
    db.log(a.campaign, f"clipper_done account={a.account} raw={len(raw_clips)}")
    caption = platform.caption(campaign)
    kept = 0
    for clip in raw_clips:
        final = overlay.apply(clip, campaign["required"]["overlay_text"], WORK / "final")
        ok, reason = checks.validate(final, rules, forbidden=campaign.get("forbidden", {}))
        if not ok:
            db.insert_clip(a.campaign, a.account, str(final), status="rejected_precheck", note=reason); continue
        url = storage.upload(final, prefix=f"{a.campaign}/{a.account}")
        db.insert_clip(a.campaign, a.account, url, status="ready", caption=caption,
                       hook_type=overlay.hook_type_of(clip))
        kept += 1
    db.log(a.campaign, f"pipeline_done account={a.account} kept={kept}/{len(raw_clips)}")


if __name__ == "__main__":
    main()
