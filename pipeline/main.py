"""Schwerer Job (GitHub Actions): Footage → Clips → Overlay → Checks → R2 → D1 (über Worker-API).
Clips landen nach den Checks als 'ready'; der Publisher postet sie automatisch zu den Slots. Telegram informiert nur.
Aufruf: python -m pipeline.main --campaign <id> --account A
Env: CLIPFORGE_API_URL, CLIPFORGE_API_KEY, GOOGLE_API_KEY (Gemini für die Momentwahl im Clipper)
"""
import argparse, re, sys, yaml
from pathlib import Path
from pipeline import download, overlay, checks, storage, db, clipper, ai
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
                                label_url=campaign["footage"].get("url", ""), max_clips=max_clips,
                                subtitle_style=acct.get("subtitle_style"))
        except Exception as e:                        # eine kaputte Quelle bricht den Job nicht ab
            db.log(a.campaign, f"clipper_error account={a.account} src={src.name} err={str(e)[:120]}"); continue
        db.log(a.campaign, f"clipper_done account={a.account} src={src.name} raw={len(clips)}")
        hooks = clipper.hooks_of(WORK / a.account / f"src{i}")
        raw_clips += [(i, c, hooks.get(re.search(r"rank_(\d+)", c.name).group(1), {})) for c in clips]
    kept = 0
    overlay_text = (campaign.get("required") or {}).get("overlay_text") or ""
    th = acct.get("text_hook") or {}
    for i, clip, meta in raw_clips:
        hook = meta.get("hook", "")
        gen = ai.enrich(hook, meta.get("description", ""), meta.get("transcript", ""), campaign["name"])   # Hook-Satz + Kommentar-Frage
        caption_hook, pinned = gen["caption_hook"] or meta.get("caption_hook", ""), gen["pinned_comment"] or meta.get("pinned_comment", "")
        caption = platform.caption(campaign, hook=caption_hook)
        staged = overlay.apply(clip, overlay_text, WORK / "stage", name=f"s{i}_{clip.name}")     # Pflicht-Overlay (falls Kampagne)
        if th.get("enabled"):                                                                # Branding A: 2-s-Text-Hook
            final = overlay.apply_text_hook(staged, caption_hook or hook, WORK / "final", name=f"s{i}_{clip.name}",
                                            seconds=float(th.get("seconds", 2)), color=str(th.get("color", "white")), accent=str(th.get("accent", "#FF5A1F")))
        else:
            final = overlay.apply(staged, "", WORK / "final", name=f"s{i}_{clip.name}")           # Kopie
        ok, reason = checks.validate(final, rules, forbidden=campaign.get("forbidden", {}))
        dur = checks.duration_of(final)
        if not ok:
            db.insert_clip(a.campaign, a.account, str(final), status="rejected_precheck", note=reason, duration_s=dur, hook=hook, pinned_comment=pinned); continue
        url = storage.upload(final, prefix=f"{a.campaign}/{a.account}")
        r = db.insert_clip(a.campaign, a.account, url, status="ready", caption=caption,
                           hook_type=overlay.hook_type_of(clip), duration_s=dur, hook=hook, pinned_comment=pinned)
        kept += 1
        try:                                                                                 # Vorschau: Standbild + Caption per Telegram
            still = overlay.frame(final, WORK / "final" / f"{final.stem}.jpg", at=1.0)
            db.notify_photo(still, f"🖼 {campaign['name']} #{(r or {}).get('seq', '?')} · Account {a.account} · {round(dur or 0)}s\n"
                                   f"Caption:\n{caption}\n\n📌 Kommentar: {pinned or '–'}\n{url}")
        except Exception as e:
            print("preview failed:", e)
    db.log(a.campaign, f"pipeline_done account={a.account} kept={kept}/{len(raw_clips)}")
    db.notify(f"✂️ Clip-Job fertig: {campaign['name']} – Account {a.account}: {kept} Clips bereit (von {len(raw_clips)} geschnitten). "
              f"Publisher postet sie zu den nächsten Slots.")


if __name__ == "__main__":
    main()
