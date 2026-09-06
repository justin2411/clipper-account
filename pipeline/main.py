"""Schwerer Job (GitHub Actions): Footage → Clips → Overlay → Checks → R2 → D1 (über Worker-API).
Clips landen nach den Checks als 'ready'; der Publisher plant sie automatisch (paid > fan-neu > backlog). Telegram informiert nur.
Aufruf: python -m pipeline.main --campaign <id> --account A|B|AB
  paid-Kampagne: ein Account je Job (eigener Schnittstil).
  fan-Kampagne (kind='fan', Footage = YouTube-Video): --account AB → EIN Schnitt, Momente nach Rang verteilt
  (A: 1,3,5… B: 2,4,6…), immer mit Hook-Text (nie roh), Caption „<Hook> · Credit @mrbeast #mrbeast“.
Env: CLIPFORGE_API_URL, CLIPFORGE_API_KEY, GOOGLE_API_KEY (Gemini), PREVIEW=true (Standbilder per Telegram)
"""
import copy, argparse, os, re, subprocess, sys, yaml
from pathlib import Path
from pipeline import download, overlay, checks, storage, db, clipper, ai, progress as PG
from platforms import REGISTRY

ROOT = Path(__file__).resolve().parent.parent
WORK = Path("work").resolve(); WORK.mkdir(exist_ok=True)
MIN_SOURCE_S = 180        # kürzere Quellen (Shorts/Teaser) werden nicht geclippt
MIN_SOURCE_HEIGHT = 480   # alte Videos: unter 480p aussortieren, 480–1079p auf 1080 hochskalieren (Vermerk im QA-Bericht)


def load_yaml(p): return yaml.safe_load(Path(p).read_text())


def montage_jobs(a, campaign, sources, targets, eff, by_id, brand_of, review_mode, video_id, WORK, kind):
    """Automatische Montage: 3–4 Stellen des Quellvideos zu einer Linie, Untertitel, Hook, Ton, Prüfung.
    Rückgabe: Anzahl angelegter Clips je Account. Liefert die Auswahl nichts, greift der alte Weg."""
    from pipeline import montage, transcribe, subtitles as SUB
    src = sources[0]
    db.log(a.campaign, f"stage=transcript account={''.join(targets)} montage")
    PG.stage("transcript")
    tr = transcribe.transcribe(src, WORK / "tr", campaign=a.campaign)
    words = tr.get("words") or []
    if not words:
        db.log(a.campaign, "montage_abbruch kein Transkript"); PG.failed("kein Transkript"); return {}
    _, _, dur = montage.probe(src)
    n = max(2, int(((eff.get(targets[0]) or {}).get("settings") or {}).get("select", {}).get("render_top", 6)))
    db.log(a.campaign, f"stage=moments account={''.join(targets)} montage kandidaten={n}")
    PG.stage("moments", detail=f"{n} Kandidaten")
    kandidaten = montage.select(tr.get("text") or "", dur, n)
    if not kandidaten:
        db.log(a.campaign, "montage_abbruch keine gültige Auswahl"); PG.failed("keine gültige Auswahl"); return {}
    kept = {t: 0 for t in targets}
    for i, clip in enumerate(kandidaten):
        acc = targets[i % len(targets)]
        vis = ((eff.get(acc) or {}).get("settings") or {}).get("visual") or {}
        hook_style = {**(brand_of(acc) if isinstance(brand_of(acc), dict) else {}), **{k: v for k, v in vis.items() if not isinstance(v, dict)}}
        sub_style = {k: v for k, v in {"font": vis.get("font"), "color": vis.get("color"), "accent": vis.get("accent")}.items() if v}
        name = f"{acc}_montage{i + 1}.mp4"
        PG.stage("cut", detail=f"Clip {i + 1} von {len(kandidaten)} · Account {acc}")
        try:
            r = montage.render_clip(src, clip, words, WORK / "final" / name, WORK / "mont" / f"{acc}{i + 1}",
                                    account=acc, hook_style=hook_style, sub_style=sub_style)
        except Exception as e:
            db.log(a.campaign, f"montage_fehler account={acc} clip={i + 1} err={str(e)[:120]}"); continue
        final = Path(r["path"])
        qa = r["qa"]
        caption = platform_caption(campaign, clip, eff, acc, kind)
        prefix = f"{a.campaign}/{acc}"
        url = storage.upload(final, prefix=prefix)
        thumb_url = cover_url = None
        try:
            still = overlay.frame(final, WORK / "final" / f"{final.stem}.jpg", at=1.0)
            thumb_url = storage.upload(still, prefix=prefix)
            cover = overlay.cover_frame(final, str(clip.get("hook_text") or ""), hook_style, clip.get("accent_word"),
                                        WORK / "final" / f"{final.stem}.cover.png", WORK / "final" / f"{final.stem}.cover.jpg",
                                        cover_style=overlay.cover_style_from_visual(vis))
            cover_url = storage.upload(WORK / "final" / f"{final.stem}.cover.jpg", prefix=prefix)
            void = cover; del void
        except Exception as e:
            print("Standbild/Cover fehlgeschlagen:", e)
        status = "review" if (review_mode.get(acc) or not qa["ok"]) else "ready"
        note = None if qa["ok"] else "QA: " + " · ".join(qa["notes"][:2])
        seg = (clip.get("segments") or [{}])[0]
        rec = db.insert_clip(a.campaign, acc, url, status=status, caption=caption, hook_type="montage",
                             duration_s=r["duration_s"], hook=str(clip.get("hook_text") or ""), pinned_comment=str(clip.get("pinned_comment") or ""),
                             video_id=video_id, rank=i + 1, thumb_url=thumb_url, context_line=str(clip.get("context_line") or ""),
                             cover_url=cover_url, scores=None, qa={**qa, "line": clip.get("line"), "segments": clip.get("segments")},
                             variant=None, start_s=seg.get("start"), end_s=seg.get("end"),
                             probe=1 if int(os.environ.get("PROBE") or 0) else 0)
        if video_id:
            db.record_usage(video_id, clip.get("segments") or [], (rec or {}).get("id"), acc)   # Sperrliste: jede Stelle
        kept[acc] += 1
        db.log(a.campaign, f"montage_clip account={acc} {r['duration_s']}s teile={len(r['plan']['parts'])} qa={qa['score']} "
                           f"{'ok' if qa['ok'] else 'zur Vorschau: ' + (qa['notes'][0] if qa['notes'] else '')}"[:180])
    return kept


def platform_caption(campaign, clip, eff, acc, kind):
    from platforms import REGISTRY
    hook = str(clip.get("context_line") or clip.get("hook_text") or "")
    caption = REGISTRY[campaign["platform"]].caption(campaign, hook=hook)
    capset = ((eff.get(acc) or {}).get("settings") or {}).get("caption") or {}
    if kind == "fan" and capset.get("template"):
        caption = capset["template"].replace("{hook}", hook)
    return caption


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--campaign", required=True); ap.add_argument("--account", required=True)
    a = ap.parse_args()

    campaign = db.get_campaign(a.campaign)
    kind = campaign.get("kind") or "paid"
    accounts_cfg = load_yaml(ROOT / "config/accounts.yaml")
    by_id = {x["id"]: x for x in accounts_cfg["accounts"]}
    brand = (load_yaml(ROOT / "config/brand.yaml") if (ROOT / "config/brand.yaml").exists() else {}) or {}
    brand_of = lambda acc: (brand.get("accounts") or {}).get(acc)          # Style-Tokens (Stufe 2); sonst text_hook aus accounts.yaml
    targets = list(a.account.upper()) if len(a.account) > 1 else [a.account]     # "AB" = alle Accounts der Nische
    for t in targets:
        if t not in by_id: sys.exit(f"unbekannter Account {t}")
    platform = REGISTRY[campaign["platform"]]
    rules = platform.rules(campaign)
    # Feinjustierung aus dem Dashboard (Nische → Account-Override) + Review-Feedback als Few-Shot
    eff = {t: db.effective_settings(t) for t in targets}
    niche_key = (eff.get(targets[0]) or {}).get("niche") or campaign.get("niche_id")
    from pipeline import moments
    moments.SETTINGS = (eff.get(targets[0]) or {}).get("settings") or {}
    moments.HINTS = db.feedback_hints(niche_key) or {}
    review_mode = {t: ((eff.get(t) or {}).get("settings") or {}).get("mode") == "review" for t in targets}
    video_id = (campaign.get("footage") or {}).get("video_id")
    label = a.account.upper()

    os.environ["CLIPFORGE_CAMPAIGN"] = a.campaign                     # Stufen-Events aus dem Clipper (Transkript, Momentwahl)
    if os.environ.get("RESUME"):                                      # „Stufe wiederholen": Transkript kommt aus dem Zwischenspeicher
        db.log(a.campaign, f"stage_wiederholung ab={os.environ['RESUME']} skip_ranks={os.environ.get('SKIP_RANKS') or '-'}")
    db.log(a.campaign, f"stage=download account={label}")
    PG.start(a.campaign, account=label, upload_id=(campaign.get("footage") or {}).get("upload_id"))
    PG.stage("download", detail=(campaign.get("footage") or {}).get("type"))
    try:
        sources = download.fetch(campaign["footage"], WORK / "src")
    except Exception as e:                            # z.B. YouTube-Bot-Check → Video als Fehler markieren, Job sauber beenden
        full = str(e).replace("\n", " ")
        bot = "not a bot" in full or "exporting-youtube-cookies" in full
        m = re.search(r"ERROR: \[youtube\] [\w-]+: ([^\n]{0,140})", str(e))
        err = (m.group(1) if m else full[-160:])
        db.log(a.campaign, f"footage_error account={label} err={err[:120]}")
        PG.failed(err[:160])
        if video_id: db.patch_video(video_id, status="error", note=("bot check" if bot else "download: " + err[:100]))
        db.notify(f"⚠️ Footage-Download fehlgeschlagen: {campaign['name']}\n{err[:200]}")
        sys.exit(0)
    if not sources:
        db.log(a.campaign, f"footage_missing account={label}")
        PG.failed("keine Quelldatei")
        if video_id: db.patch_video(video_id, status="error", note="download failed")
        sys.exit(0)
    db.log(a.campaign, f"footage_ok account={label} files={len(sources)} bytes={sum(s.stat().st_size for s in sources)}")
    if kind == "fan":
        src_dur = checks.duration_of(sources[0]) or 0
        if video_id: db.patch_video(video_id, duration_s=int(src_dur))
        if src_dur < MIN_SOURCE_S or clipper.is_vertical(sources[0]):
            db.log(a.campaign, f"footage_skipped account={label} reason={'short' if src_dur < MIN_SOURCE_S else 'vertical'} dur={src_dur:.0f}")
            if video_id: db.patch_video(video_id, status="skipped", note="short/vertical", is_short=1)
            up = (campaign.get("footage") or {}).get("upload_id")
            if up: db.patch_upload(up, status="error", note="zu kurz (< 3 min)" if src_dur < MIN_SOURCE_S else "vertikales Video")
            db.notify(f"⏭ Fan-Video übersprungen ({'zu kurz' if src_dur < MIN_SOURCE_S else 'vertikal'}): {campaign['name']}")
            return

    # Alte Videos technisch: vor 2019 liefert YouTube oft nur 720p oder weniger. Unter 480p wird aussortiert,
    # zwischen 480p und 1080p wird auf 1080 Breite hochskaliert und im QA-Bericht vermerkt.
    src_notes: list[str] = []
    for i, src in enumerate(list(sources)):
        w, h = overlay.probe_size(src)
        short_side = min(w, h)
        if video_id and i == 0:
            db.patch_video(video_id, height=int(short_side))
        if short_side < MIN_SOURCE_HEIGHT:
            db.log(a.campaign, f"footage_low_res account={label} src={src.name} {w}x{h} < {MIN_SOURCE_HEIGHT}p – aussortiert")
            if video_id: db.patch_video(video_id, status="skipped", note=f"Quelle nur {short_side}p")
            sources.remove(src); continue
        if short_side < 1080:
            up = src.with_name(src.stem + ".up1080.mp4")
            subprocess.run(["ffmpeg", "-y", "-i", str(src), "-vf", "scale=-2:1080:flags=lanczos", "-c:v", "libx264", "-crf", "18",
                            "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", str(up)], check=True, capture_output=True)
            sources[sources.index(src)] = up
            src_notes.append(f"Quelle {short_side}p auf 1080p hochskaliert")
            db.log(a.campaign, f"footage_upscaled account={label} {short_side}p → 1080p")
    if not sources:
        db.log(a.campaign, f"footage_missing account={label} alle Quellen unter {MIN_SOURCE_HEIGHT}p")
        db.notify(f"⏭ Quelle aussortiert (unter {MIN_SOURCE_HEIGHT}p): {campaign['name']}")
        return

    # Automatische Montage (Standard): 3–4 Stellen des Quellvideos zu einer Linie, mit Untertiteln.
    # Liefert die Auswahl nichts Gültiges, greift der alte Weg (ein Ausschnitt je Clip) als Rückfall.
    montage_an = str(((eff.get(targets[0]) or {}).get("settings") or {}).get("montage", {}).get("enabled", True)).lower() not in ("false", "0", "no")
    if montage_an and os.environ.get("MONTAGE", "1").lower() not in ("0", "false", "no"):
        try:
            kept_m = montage_jobs(a, campaign, sources, targets, eff, by_id, brand_of, review_mode, video_id, WORK, kind)
        except Exception as e:      # ein Fehler in der Montage darf nicht die halbe Stunde Transkript wegwerfen
            db.log(a.campaign, f"montage_fehler_gesamt {type(e).__name__}: {str(e)[:140]}")
            print("montage failed:", repr(e))
            kept_m = {}
        if sum(kept_m.values()):
            db.log(a.campaign, f"pipeline_done montage clips={sum(kept_m.values())} " + " ".join(f"{k}={v}" for k, v in kept_m.items()))
            PG.done(f"{sum(kept_m.values())} Clips")
            if video_id: db.patch_video(video_id, status="clipped")
            up = (campaign.get("footage") or {}).get("upload_id")
            if up: db.patch_upload(up, status="clipped")
            return
        db.log(a.campaign, "montage leer – alter Weg (ein Ausschnitt je Clip)")

    # Schnitt: paid → je Account eigener Stil; fan → ein Schnitt (fan-Profil), Verteilung nach Rang
    jobs: list[tuple[str, int, Path, dict, int]] = []   # (account, src-index, clip, meta, rank)
    rank_of = lambda c: int(re.search(r"rank_(\d+)", c.name).group(1))
    if kind == "fan":
        prof = accounts_cfg.get("fan") or {}
        flags = prof.get("clipper_flags") or by_id[targets[0]]["clipper_flags"]
        max_clips = int(prof.get("max_clips_per_source", 6))
        if int(os.environ.get("PROBE") or 0):                     # Probelauf: gesperrte Ränge mitrendern, sie fallen danach raus
            max_clips = int(os.environ["PROBE"]) + len({int(x) for x in re.findall(r"\d+", os.environ.get("SKIP_RANKS") or "")})
        for i, src in enumerate(sources):
            try:
                clips = clipper.run(src, flags, WORK / "AB" / f"src{i}", label_url=campaign["footage"].get("url", ""), max_clips=max_clips)
            except Exception as e:
                db.log(a.campaign, f"clipper_error account={label} src={src.name} err={str(e)[:120]}"); continue
            db.log(a.campaign, f"clipper_done account={label} src={src.name} raw={len(clips)}")
            db.log(a.campaign, f"stage=render account={label} raw={len(clips)}")
            PG.stage("render", detail=f"{len(clips)} Rohclips")
            hooks = clipper.hooks_of(WORK / "AB" / f"src{i}")
            for c in sorted(clips, key=rank_of):
                r = rank_of(c)
                acc = targets[(r - 1) % len(targets)] if len(targets) > 1 else targets[0]   # A: 1,3,5… B: 2,4,6…
                jobs.append((acc, i, c, hooks.get(str(r), {}), r))
    else:
        max_clips = int(accounts_cfg.get("max_clips_per_source", clipper.DEFAULT_MAX_CLIPS))
        if int(os.environ.get("PROBE") or 0):
            max_clips = int(os.environ["PROBE"]) + len({int(x) for x in re.findall(r"\d+", os.environ.get("SKIP_RANKS") or "")})
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

    # Probelauf (PROBE=2): nur die zwei bestbewerteten Momente produzieren, danach hält die Produktion an.
    # SKIP_RANKS sperrt schon gezeigte Ränge, damit „Nochmal, andere Momente" wirklich andere liefert.
    probe_n = int(os.environ.get("PROBE") or 0)
    skip_ranks = {int(x) for x in re.findall(r"\d+", os.environ.get("SKIP_RANKS") or "")}
    if skip_ranks:
        before = len(jobs)
        jobs = [j for j in jobs if j[4] not in skip_ranks]
        db.log(a.campaign, f"skip_ranks account={label} gesperrt={sorted(skip_ranks)} von {before} auf {len(jobs)} Momente")
    if probe_n > 0:
        jobs = sorted(jobs, key=lambda j: j[4])[:probe_n]
        db.log(a.campaign, f"probe account={label} clips={len(jobs)} raenge={[j[4] for j in jobs]}")

    kept = {t: 0 for t in targets}
    previews = {t: 0 for t in targets}
    preview_on = kind != "fan" or os.environ.get("PREVIEW", "").lower() in ("1", "true", "yes")   # Stufen-Test: 3 Standbilder je Account
    overlay_text = (campaign.get("required") or {}).get("overlay_text") or ""
    for acc, i, clip, meta, rank in jobs:
        th = by_id[acc].get("text_hook") or {}
        hook = meta.get("hook", "")
        # Originalität: Kontextzeile in eigenen Worten (≤8 Wörter, kein Transkript-Zitat) = Hook-Text im Bild + erster Caption-Satz.
        # Kommt aus der Momentwahl (Stufe 3); fehlt sie oder zitiert sie das Transkript, liefert ai.enrich() Ersatz.
        transcript = meta.get("transcript", "")
        context_line = meta.get("context_line") or ""
        accent_word, pinned = meta.get("accent_word") or "", meta.get("pinned_comment", "")
        if not context_line or len(context_line.split()) > ai.MAX_WORDS or ai.quotes_transcript(context_line, transcript) or not pinned:
            gen = ai.enrich(hook, meta.get("description", ""), transcript, campaign["name"])
            if not context_line or len(context_line.split()) > ai.MAX_WORDS or ai.quotes_transcript(context_line, transcript):
                context_line, accent_word = gen.get("context_line") or gen.get("caption_hook") or hook, gen.get("accent_word") or ""
            pinned = pinned or gen["pinned_comment"]
        if not accent_word or accent_word.lower().strip(".,!?\"'") not in [w.lower().strip(".,!?\"'") for w in context_line.split()]:
            accent_word = ai._pick_accent(context_line)
        caption = platform.caption(campaign, hook=context_line)
        name = f"{acc}_s{i}_{clip.name}"
        if not context_line.strip():                                                          # nie roh (Fan wie paid)
            db.insert_clip(a.campaign, acc, str(clip), status="rejected_precheck", note="no_hook", hook=hook, video_id=video_id, rank=rank); continue
        eff_acc = copy.deepcopy((eff.get(acc) or {}).get("settings") or {})
        variant = None
        ab = (eff.get(acc) or {}).get("ab") or {}                                            # A/B-Test (Stufe 4): Clips abwechselnd mit den Varianten rendern
        if ab.get("variable") and len(ab.get("variants") or []) >= 2 and ab.get("niche") in (None, niche_key):
            val = ab["variants"][i % len(ab["variants"])]
            path = str(ab["variable"]).split("."); node = eff_acc
            for k in path[:-1]: node = node.setdefault(k, {})
            node[path[-1]] = float(val) if re.fullmatch(r"-?\d+(\.\d+)?", str(val)) else val
            variant = f"{ab['variable']}={val}"
        vis = eff_acc.get("visual") or {}
        style = brand_of(acc) or str(th.get("style", "bar"))
        if vis.get("font"):                                                                  # Dashboard-Look (Feinjustierung) überschreibt brand.yaml
            style = {**(style if isinstance(style, dict) else {}), **overlay.style_from_visual(vis)}
        staged, ov_geom = overlay.apply(clip, overlay_text, WORK / "stage", name=name,       # Overlay oben: eigener Layer (show/Position/Dauer aus visual.overlay)
                                        style=overlay.overlay_style_from_visual(vis), fallback=context_line)
        capset = eff_acc.get("caption") or {}
        if kind == "fan" and capset.get("template"):
            caption = capset["template"].replace("{hook}", context_line)
        final, cover_jpg, qa_render = overlay.apply_text_hook(staged, context_line, WORK / "final", name=name,
                                                   seconds=float(th.get("seconds", 2)), color=str(th.get("color", "white")),
                                                   accent=str(th.get("accent", "#FF5A1F")), style=style,
                                                   accent_word=accent_word, cover=True,
                                                   cover_style=overlay.cover_style_from_visual(vis), overlay_geom=ov_geom)
        if qa_render.get("notes"):
            db.log(a.campaign, f"render_layout account={acc} {qa_render['notes'][0][:120]}")
        ok, reason = checks.validate(final, rules, forbidden=campaign.get("forbidden", {}))
        dur = checks.duration_of(final)
        if not ok:
            db.insert_clip(a.campaign, acc, str(final), status="rejected_precheck", note=reason, duration_s=dur, hook=hook,
                           pinned_comment=pinned, video_id=video_id, rank=rank, context_line=context_line, variant=variant); continue
        prefix = f"{a.campaign}/{acc}"
        url = storage.upload(final, prefix=prefix)
        thumb_url = cover_url = None
        try:
            still = overlay.frame(final, WORK / "final" / f"{final.stem}.jpg", at=1.0)
            thumb_url = storage.upload(still, prefix=prefix)
            if cover_jpg and cover_jpg.exists():
                cover_url = storage.upload(cover_jpg, prefix=prefix)
        except Exception as e:
            print("thumbnail failed:", e)
        qa_report = {"notes": [*src_notes, *qa_render.get("notes", [])], "overlay": {"used": bool(ov_geom.get("used")), "bottom_pct": ov_geom.get("bottom_pct", 0)},
                     "hook_moved_px": qa_render.get("hook_moved_px", 0), "overlap_risk": bool(qa_render.get("overlap_risk"))}
        r = db.insert_clip(a.campaign, acc, url, status="review" if review_mode.get(acc) else "ready", caption=caption, hook_type=overlay.hook_type_of(clip),
                           duration_s=dur, hook=hook, pinned_comment=pinned, video_id=video_id, rank=rank, thumb_url=thumb_url,
                           context_line=context_line, cover_url=cover_url, scores=meta.get("scores"), qa=qa_report, variant=variant,
                           start_s=meta.get("start"), end_s=meta.get("end"), probe=1 if probe_n > 0 else 0)
        kept[acc] += 1
        if preview_on and previews[acc] < 3:                                                 # Vorschau: Standbild (Hook sichtbar) + Caption
            previews[acc] += 1
            try:
                db.notify_photo(WORK / "final" / f"{final.stem}.jpg", f"🖼 {campaign['name']} #{(r or {}).get('seq', '?')} · Account {acc} · {round(dur or 0)}s\n"
                                                                     f"Caption:\n{caption}\n\n📌 Kommentar: {pinned or '–'}")
                if cover_jpg and cover_jpg.exists():
                    db.notify_photo(cover_jpg, f"🖼 Cover #{(r or {}).get('seq', '?')} · Account {acc}")
            except Exception as e:
                print("preview failed:", e)
    total = sum(kept.values())
    db.log(a.campaign, f"pipeline_done account={label} kept={total}/{len(jobs)} " + " ".join(f"{k}={v}" for k, v in kept.items()))
    if total:
        PG.done(f"{total} von {len(jobs)} Clips")
    else:
        PG.failed(f"0 von {len(jobs)} Clips behalten")
    if video_id:
        db.patch_video(video_id, status="clipped" if total else "error", note=None if total else f"0 of {len(jobs)} kept")
    upload_id = (campaign.get("footage") or {}).get("upload_id")
    if upload_id:
        db.patch_upload(upload_id, status="clipped" if total else "error", note=None if total else f"0 of {len(jobs)} kept")
    per = ", ".join(f"{k}: {v}" for k, v in kept.items())
    db.notify(f"✂️ Clip-Job fertig ({'⭐ Fan' if kind == 'fan' else '💰 Paid'}): {campaign['name']} – {per} Clips bereit (von {len(jobs)} geschnitten). "
              f"Der Planer verteilt sie auf die nächsten Slots.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:                     # ein abgestürzter Lauf meldet sich ab, statt still als „läuft" stehen zu bleiben
        PG.failed(str(e)[:200])
        raise
    finally:
        PG.stop()
