"""Schwerer Job (GitHub Actions): Footage → Clips → Overlay → Checks → R2 → D1 (über Worker-API).
Clips landen nach den Checks als 'ready'; der Publisher plant sie automatisch (paid > fan-neu > backlog). Telegram informiert nur.
Aufruf: python -m pipeline.main --campaign <id> --account A|B|AB
  paid-Kampagne: ein Account je Job (eigener Schnittstil).
  fan-Kampagne (kind='fan', Footage = YouTube-Video): --account AB → EIN Schnitt, Momente nach Rang verteilt
  (A: 1,3,5… B: 2,4,6…), immer mit Hook-Text (nie roh), Caption „<Hook> · Credit @mrbeast #mrbeast“.
Env: CLIPFORGE_API_URL, CLIPFORGE_API_KEY, GOOGLE_API_KEY (Gemini), optional YT_COOKIES_B64
"""
import argparse, re, sys, yaml
from pathlib import Path
from pipeline import download, overlay, checks, storage, db, clipper, ai
from platforms import REGISTRY

ROOT = Path(__file__).resolve().parent.parent
WORK = Path("work").resolve(); WORK.mkdir(exist_ok=True)
MIN_SOURCE_S = 180        # kürzere Quellen (Shorts/Teaser) werden nicht geclippt


def load_yaml(p): return yaml.safe_load(Path(p).read_text())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--campaign", required=True); ap.add_argument("--account", required=True)
    a = ap.parse_args()

    campaign = db.get_campaign(a.campaign)
    kind = campaign.get("kind") or "paid"
    accounts_cfg = load_yaml(ROOT / "config/accounts.yaml")
    by_id = {x["id"]: x for x in accounts_cfg["accounts"]}
    targets = ["A", "B"] if a.account.upper() == "AB" else [a.account]
    for t in targets:
        if t not in by_id: sys.exit(f"unbekannter Account {t}")
    platform = REGISTRY[campaign["platform"]]
    rules = platform.rules(campaign)
    video_id = (campaign.get("footage") or {}).get("video_id")
    label = a.account.upper()

    sources = download.fetch(campaign["footage"], WORK / "src")
    if not sources:
        db.log(a.campaign, f"footage_missing account={label}")
        if video_id: db.patch_video(video_id, status="error", note="download failed")
        sys.exit(0)
    db.log(a.campaign, f"footage_ok account={label} files={len(sources)} bytes={sum(s.stat().st_size for s in sources)}")
    if kind == "fan":
        src_dur = checks.duration_of(sources[0]) or 0
        if video_id: db.patch_video(video_id, duration_s=int(src_dur))
        if src_dur < MIN_SOURCE_S or clipper.is_vertical(sources[0]):
            db.log(a.campaign, f"footage_skipped account={label} reason={'short' if src_dur < MIN_SOURCE_S else 'vertical'} dur={src_dur:.0f}")
            if video_id: db.patch_video(video_id, status="skipped", note="short/vertical", is_short=1)
            db.notify(f"⏭ Fan-Video übersprungen ({'zu kurz' if src_dur < MIN_SOURCE_S else 'vertikal'}): {campaign['name']}")
            return

    # Schnitt: paid → je Account eigener Stil; fan → ein Schnitt (fan-Profil), Verteilung nach Rang
    jobs: list[tuple[str, int, Path, dict, int]] = []   # (account, src-index, clip, meta, rank)
    rank_of = lambda c: int(re.search(r"rank_(\d+)", c.name).group(1))
    if kind == "fan":
        prof = accounts_cfg.get("fan") or {}
        flags = prof.get("clipper_flags") or by_id[targets[0]]["clipper_flags"]
        max_clips = int(prof.get("max_clips_per_source", 6))
        for i, src in enumerate(sources):
            try:
                clips = clipper.run(src, flags, WORK / "AB" / f"src{i}", label_url=campaign["footage"].get("url", ""), max_clips=max_clips)
            except Exception as e:
                db.log(a.campaign, f"clipper_error account={label} src={src.name} err={str(e)[:120]}"); continue
            db.log(a.campaign, f"clipper_done account={label} src={src.name} raw={len(clips)}")
            hooks = clipper.hooks_of(WORK / "AB" / f"src{i}")
            for c in sorted(clips, key=rank_of):
                r = rank_of(c)
                acc = targets[(r - 1) % len(targets)] if len(targets) > 1 else targets[0]   # A: 1,3,5… B: 2,4,6…
                jobs.append((acc, i, c, hooks.get(str(r), {}), r))
    else:
        max_clips = int(accounts_cfg.get("max_clips_per_source", clipper.DEFAULT_MAX_CLIPS))
        for acc in targets:
            for i, src in enumerate(sources):
                try:
                    clips = clipper.run(src, by_id[acc]["clipper_flags"], WORK / acc / f"src{i}",
                                        label_url=campaign["footage"].get("url", ""), max_clips=max_clips)
                except Exception as e:
                    db.log(a.campaign, f"clipper_error account={acc} src={src.name} err={str(e)[:120]}"); continue
                db.log(a.campaign, f"clipper_done account={acc} src={src.name} raw={len(clips)}")
                hooks = clipper.hooks_of(WORK / acc / f"src{i}")
                jobs += [(acc, i, c, hooks.get(str(rank_of(c)), {}), rank_of(c)) for c in clips]

    kept = {t: 0 for t in targets}
    overlay_text = (campaign.get("required") or {}).get("overlay_text") or ""
    for acc, i, clip, meta, rank in jobs:
        th = by_id[acc].get("text_hook") or {}
        hook = meta.get("hook", "")
        gen = ai.enrich(hook, meta.get("description", ""), meta.get("transcript", ""), campaign["name"])   # Hook-Satz + Kommentar-Frage
        caption_hook = gen["caption_hook"] or meta.get("caption_hook", "") or hook
        pinned = gen["pinned_comment"] or meta.get("pinned_comment", "")
        text_hook = gen.get("overlay_hook") or caption_hook or hook
        caption = platform.caption(campaign, hook=caption_hook)
        name = f"{acc}_s{i}_{clip.name}"
        staged = overlay.apply(clip, overlay_text, WORK / "stage", name=name)                # Pflicht-Overlay (paid, falls gesetzt)
        if kind == "fan" and not text_hook.strip():                                           # Fan-Clips nie roh
            db.insert_clip(a.campaign, acc, str(staged), status="rejected_precheck", note="no_hook", hook=hook, video_id=video_id, rank=rank); continue
        if th.get("enabled") or kind == "fan":                                                # Branding: 2-s-Hook-Text unten (65–72 %)
            final = overlay.apply_text_hook(staged, text_hook, WORK / "final", name=name,
                                            seconds=float(th.get("seconds", 2)), color=str(th.get("color", "white")),
                                            accent=str(th.get("accent", "#FF5A1F")), style=str(th.get("style", "bar")))
        else:
            final = overlay.apply(staged, "", WORK / "final", name=name)                       # Kopie
        ok, reason = checks.validate(final, rules, forbidden=campaign.get("forbidden", {}))
        dur = checks.duration_of(final)
        if not ok:
            db.insert_clip(a.campaign, acc, str(final), status="rejected_precheck", note=reason, duration_s=dur, hook=hook,
                           pinned_comment=pinned, video_id=video_id, rank=rank); continue
        prefix = f"{a.campaign}/{acc}"
        url = storage.upload(final, prefix=prefix)
        thumb_url = None
        try:
            still = overlay.frame(final, WORK / "final" / f"{final.stem}.jpg", at=1.0)
            thumb_url = storage.upload(still, prefix=prefix)
        except Exception as e:
            print("thumbnail failed:", e)
        r = db.insert_clip(a.campaign, acc, url, status="ready", caption=caption, hook_type=overlay.hook_type_of(clip),
                           duration_s=dur, hook=hook, pinned_comment=pinned, video_id=video_id, rank=rank, thumb_url=thumb_url)
        kept[acc] += 1
        if kind != "fan":                                                                    # paid: Vorschau je Clip per Telegram
            try:
                db.notify_photo(WORK / "final" / f"{final.stem}.jpg", f"🖼 {campaign['name']} #{(r or {}).get('seq', '?')} · Account {acc} · {round(dur or 0)}s\n"
                                                                     f"Caption:\n{caption}\n\n📌 Kommentar: {pinned or '–'}\n{url}")
            except Exception as e:
                print("preview failed:", e)
    total = sum(kept.values())
    db.log(a.campaign, f"pipeline_done account={label} kept={total}/{len(jobs)} " + " ".join(f"{k}={v}" for k, v in kept.items()))
    if video_id:
        db.patch_video(video_id, status="clipped" if total else "error", note=None if total else f"0 of {len(jobs)} kept")
    per = ", ".join(f"{k}: {v}" for k, v in kept.items())
    db.notify(f"✂️ Clip-Job fertig ({'⭐ Fan' if kind == 'fan' else '💰 Paid'}): {campaign['name']} – {per} Clips bereit (von {len(jobs)} geschnitten). "
              f"Der Planer verteilt sie auf die nächsten Slots.")


if __name__ == "__main__":
    main()
