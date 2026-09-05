#!/usr/bin/env python3
"""
vyro_submit.py – reicht Post-URLs bei Vyro ein (Browser-Automatisierung, lokal auf deinem Mac).

Grundsätze, damit nichts Halbes passiert:
  1. Jeder Post wird nur eingereicht, wenn der Worker ihn als "offen" kennt (Quelle: /submissions/pending).
  2. Vor dem Klick auf "Submit post" müssen ALLE Vyro-Checks grün sein – sonst Abbruch mit Screenshot.
  3. Nach dem Klick wird der Erfolg auf der Seite VERIFIZIERT, erst dann meldet das Skript "submitted" an den Worker.
  4. Zwei Fehler in Folge → sofortiger Stopp + Telegram. Selektoren liegen in vyro_selectors.json
     (aus dem Vyro-Frontend abgeleitet) und werden mit `--probe` bzw. `playwright codegen` an der echten Seite geprüft.
  5. --dry-run macht alles bis auf den finalen Submit-Klick.

Vyro-Ablauf (Frontend-Stand 2026-09-05):
  Kampagnenseite → Button "Submit post" → Dialog: Social-Account wählen, "Use a link instead", Post-URL,
  Checkbox "My post follows campaign rules", "Continue" → "Review your post" mit Checks
  (Ad disclosure / Video length / Hashtags / Collaborators) → "Submit post" → "Your post has been submitted!"

Setup (einmalig):
  pip install playwright requests && playwright install chromium
  python scripts/vyro_submit.py --login       # Browser öffnet sich, einloggen (Google), Fenster schließen
  python scripts/vyro_submit.py --probe       # listet Buttons/Felder der echten Seite → Selektoren prüfen
  python scripts/vyro_submit.py --dry-run     # alles außer dem Submit-Klick, Screenshots in ~/.clipforge/vyro-shots
  python scripts/vyro_submit.py               # echter Lauf (täglich 21:30 per launchd, siehe scripts/launchd)

Env: CLIPFORGE_API_URL, CLIPFORGE_API_KEY (aus SECRETS.local.md; z.B. in ~/.clipforge/env)
Worker-Endpunkte (x-api-key):
  GET  /submissions/pending  -> [{"post_id","campaign_id","campaign_url","post_url","account","account_handle"}]
  POST /submissions/mark     {"post_id","status":"submitted|failed","note"}
  POST /notify               {"text"}   (Telegram)
"""
import argparse, json, os, random, sys, time, traceback
from datetime import datetime
from pathlib import Path

import requests

API = os.environ.get("CLIPFORGE_API_URL", "").rstrip("/")
KEY = os.environ.get("CLIPFORGE_API_KEY", "")
HERE = Path(__file__).resolve().parent
PROFILE = Path.home() / ".clipforge" / "vyro-profile"
SHOTS = Path.home() / ".clipforge" / "vyro-shots"
SELECTORS_FILE = HERE / "vyro_selectors.json"
MAX_PER_RUN = 20
MAX_CONSECUTIVE_FAILS = 2
VYRO = "https://app.vyro.com"


# ---------- Hilfen ----------
def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def api(method, path, **kw):
    if not API or not KEY:
        raise SystemExit("CLIPFORGE_API_URL / CLIPFORGE_API_KEY fehlen (z.B. `set -a; source ~/.clipforge/env; set +a`)")
    r = requests.request(method, API + path, headers={"x-api-key": KEY, "Content-Type": "application/json"}, timeout=30, **kw)
    r.raise_for_status()
    return r.json() if r.text else {}


def notify(text):
    try:
        api("POST", "/notify", json={"text": text})
    except Exception as e:
        log(f"Telegram fehlgeschlagen: {e}")


def load_selectors():
    if not SELECTORS_FILE.exists():
        raise SystemExit(f"{SELECTORS_FILE} fehlt")
    return json.loads(SELECTORS_FILE.read_text())


def sel(candidates, **fmt):
    return [c.format(**fmt) if fmt else c for c in candidates]


def first_visible(page, candidates, timeout=8000):
    """Gibt den ersten sichtbaren Locator aus der Kandidatenliste zurück, sonst None."""
    deadline = time.time() + timeout / 1000
    while time.time() < deadline:
        for s in candidates:
            try:
                loc = page.locator(s).first
                if loc.is_visible():
                    return loc
            except Exception:
                pass
        time.sleep(0.25)
    return None


def pause(a=1.2, b=3.0):
    time.sleep(random.uniform(a, b))


def shot(page, name):
    SHOTS.mkdir(parents=True, exist_ok=True)
    p = SHOTS / f"{datetime.now():%Y%m%d-%H%M%S}-{name}.png"
    try:
        page.screenshot(path=str(p), full_page=True)
    except Exception:
        pass
    return p


# ---------- Kernlogik ----------
def ensure_logged_in(page, S):
    page.goto(f"{VYRO}/campaigns", wait_until="domcontentloaded")
    return first_visible(page, S["logged_in_marker"], timeout=12000) is not None


def open_submit_dialog(page, S, item):
    page.goto(item["campaign_url"], wait_until="domcontentloaded")
    pause()
    btn = first_visible(page, S["open_button"], timeout=15000)
    if not btn:
        raise RuntimeError("'Submit post'-Button nicht gefunden (Kampagne beigetreten? Seite geändert? Kampagnen-URL richtig?)")
    btn.click()
    pause(0.8, 1.8)
    if not first_visible(page, S["modal_title"], timeout=8000):
        raise RuntimeError("Submit-Dialog nicht geöffnet")


def choose_account(page, S, handle):
    """Social-Account im Dialog wählen (Handle wie @mrbeastfire0). Wenn bereits vorausgewählt: nichts tun."""
    h = handle.lstrip("@")
    if not h:
        return
    if first_visible(page, [f"role=dialog >> text=/{h}/i"], timeout=1500):
        return                                       # schon sichtbar/ausgewählt
    box = first_visible(page, S["account_select"], timeout=6000)
    if box:
        box.click()
        pause(0.5, 1.0)
    opt = first_visible(page, sel(S["account_option"], handle=h), timeout=6000)
    if not opt:
        raise RuntimeError(f"Account {handle} nicht in der Auswahl (bei Vyro verknüpft?)")
    opt.click()
    pause(0.5, 1.2)


def submit_one(page, S, item, dry_run):
    """Reicht genau einen Post ein. Wirft Exception bei jedem Zweifel."""
    open_submit_dialog(page, S, item)
    choose_account(page, S, item.get("account_handle", ""))

    link_mode = first_visible(page, S["use_link"], timeout=4000)
    if link_mode:
        link_mode.click()
        pause(0.5, 1.2)
    inp = first_visible(page, S["url_input"], timeout=10000)
    if not inp:
        raise RuntimeError("URL-Eingabefeld nicht gefunden")
    inp.fill("")
    inp.type(item["post_url"], delay=random.randint(20, 60))
    pause(1.0, 2.0)

    cb = first_visible(page, S["rules_checkbox"], timeout=4000)
    if cb:
        try:
            if not cb.is_checked():
                cb.click()
        except Exception:
            cb.click()
        pause(0.4, 0.9)

    cont = first_visible(page, S["continue_button"], timeout=6000)
    if cont:
        if not cont.is_enabled():
            raise RuntimeError("'Continue' deaktiviert – Account/Link/Checkbox unvollständig")
        cont.click()
        pause(1.0, 2.0)

    # Vyro-Prüfungen abwarten: harter Fehler → Abbruch; mindestens ein grüner Check nötig
    if first_visible(page, S["check_fail"], timeout=5000):
        raise RuntimeError("Vyro-Check meldet ein Problem (Disclosure/Länge/Collab/Duplikat/Link)")
    if not first_visible(page, S["check_pass"], timeout=25000):
        raise RuntimeError("Keine grünen Vyro-Checks sichtbar – Seite geändert oder Link nicht erkannt")
    if first_visible(page, S["check_fail"], timeout=1500):
        raise RuntimeError("Vyro-Check meldet ein Problem nach der Prüfung")
    warn = first_visible(page, S["check_warn"], timeout=1000)

    submit = first_visible(page, S["submit_button"], timeout=8000)
    if not submit:
        raise RuntimeError("Submit-Button im Prüf-Dialog nicht gefunden")
    if not submit.is_enabled():
        raise RuntimeError("Submit-Button deaktiviert – Vyro-Checks nicht vollständig grün")

    if dry_run:
        shot(page, f"dryrun-{item['post_id']}")
        log(f"DRY-RUN ok{' (mit Warnung)' if warn else ''}: {item['post_url']}")
        close = first_visible(page, S["dialog_close"], timeout=2000)
        if close:
            close.click()
        return "dry"

    submit.click()
    ok = first_visible(page, S["success_marker"], timeout=25000)
    if not ok and first_visible(page, S["check_fail"], timeout=1500):
        raise RuntimeError("Vyro hat den Post abgelehnt (Post not submitted)")
    if not ok:
        raise RuntimeError("Nach Submit keine Erfolgsbestätigung erkennbar")
    close = first_visible(page, S["dialog_close"], timeout=3000)
    if close:
        close.click()
    return "submitted"


def probe(page, S, item):
    """Listet Buttons, Felder und Texte des Dialogs – zum Abgleich der Selektoren."""
    page.goto(item["campaign_url"] if item else f"{VYRO}/campaigns", wait_until="domcontentloaded")
    pause()
    print("== Kampagnenseite: Buttons")
    for b in page.get_by_role("button").all()[:40]:
        try:
            print("  button:", repr(b.inner_text().strip()[:60]))
        except Exception:
            pass
    btn = first_visible(page, S["open_button"], timeout=8000)
    if not btn:
        print("!! 'Submit post'-Button nicht gefunden"); shot(page, "probe-nobutton"); return
    btn.click(); pause(1, 2)
    print("== Dialog: Rollen/Texte")
    for role in ("button", "combobox", "textbox", "checkbox", "option", "radio", "link"):
        for el in page.get_by_role(role).all()[:30]:
            try:
                if el.is_visible():
                    print(f"  {role}:", repr((el.get_attribute("aria-label") or el.inner_text() or el.get_attribute("placeholder") or "").strip()[:70]))
            except Exception:
                pass
    for inp in page.locator("input").all()[:20]:
        try:
            print("  input:", inp.get_attribute("type"), repr(inp.get_attribute("placeholder")), repr(inp.get_attribute("name")))
        except Exception:
            pass
    shot(page, "probe-dialog")
    print(f"Screenshot: {SHOTS}")


def run(dry_run=False, login_only=False, probe_only=False):
    from playwright.sync_api import sync_playwright
    S = load_selectors()
    PROFILE.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE), headless=False, viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"], slow_mo=60,
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        if login_only:
            page.goto(VYRO)
            log("Bitte im Browserfenster einloggen. Danach dieses Fenster schließen.")
            try:
                page.wait_for_event("close", timeout=0)
            except Exception:
                pass
            return

        if not ensure_logged_in(page, S):
            shot(page, "not-logged-in")
            notify("Vyro-Einreichung: nicht eingeloggt. Bitte `python scripts/vyro_submit.py --login` ausführen.")
            raise SystemExit("Nicht eingeloggt")

        pending = api("GET", "/submissions/pending")
        if probe_only:
            probe(page, S, pending[0] if pending else None)
            ctx.close()
            return
        if not pending:
            log("Nichts einzureichen.")
            ctx.close()
            return
        pending = pending[:MAX_PER_RUN]
        log(f"{len(pending)} Posts offen")

        done, failed, streak = [], [], 0
        for item in pending:
            if not item.get("campaign_url"):
                failed.append(f"{item['post_url']} – Kampagnen-URL fehlt (external_url setzen)")
                continue
            try:
                res = submit_one(page, S, item, dry_run)
                streak = 0
                if res == "submitted":
                    api("POST", "/submissions/mark", json={"post_id": item["post_id"], "status": "submitted", "note": "vyro_submit.py"})
                    done.append(item["post_url"])
                    log(f"eingereicht: {item['post_url']}")
                pause(6, 14)
            except Exception as e:
                streak += 1
                pth = shot(page, f"fail-{item['post_id']}")
                failed.append(f"{item['post_url']} – {e}")
                log(f"FEHLER: {e} (Screenshot {pth})")
                if not dry_run:
                    try:
                        api("POST", "/submissions/mark", json={"post_id": item["post_id"], "status": "failed", "note": str(e)[:200]})
                    except Exception:
                        pass
                if streak >= MAX_CONSECUTIVE_FAILS:
                    log("Zwei Fehler in Folge – Stopp.")
                    break
                try:
                    page.goto(f"{VYRO}/campaigns", wait_until="domcontentloaded")
                except Exception:
                    pass

        ctx.close()

    summary = f"Vyro-Einreichung{' (DRY-RUN)' if dry_run else ''}: {len(done)} eingereicht"
    if failed:
        summary += f", {len(failed)} fehlgeschlagen:\n" + "\n".join(failed[:5])
    if streak >= MAX_CONSECUTIVE_FAILS:
        summary += "\n⛔ Gestoppt nach 2 Fehlern in Folge – Selektoren prüfen (scripts/vyro_selectors.json, --probe)."
    log(summary)
    if not dry_run or failed:
        notify(summary)


def check_api():
    """Verbindungstest ohne Browser (auch aus CI/Container nutzbar)."""
    pending = api("GET", "/submissions/pending")
    print(f"API ok – {len(pending)} offene Posts")
    for it in pending:
        print(f"  {it['account']} {it.get('account_handle','')} {it['post_url']} → {it.get('campaign_url') or '!! Kampagnen-URL fehlt'}")
    return pending


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--login", action="store_true", help="einmalig einloggen, Profil speichern")
    ap.add_argument("--probe", action="store_true", help="Buttons/Felder der echten Seite auflisten (Selektoren prüfen)")
    ap.add_argument("--dry-run", action="store_true", help="alles außer dem Submit-Klick")
    ap.add_argument("--check-api", action="store_true", help="nur Worker-Verbindung und offene Posts anzeigen")
    a = ap.parse_args()
    try:
        if a.check_api:
            check_api()
        else:
            run(dry_run=a.dry_run, login_only=a.login, probe_only=a.probe)
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        notify("Vyro-Einreichung abgebrochen: " + traceback.format_exc().splitlines()[-1][:200])
        sys.exit(1)
