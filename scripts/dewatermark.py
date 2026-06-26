r"""
Remove the chordtabs.in.th watermark from every chord image in R2 — in place.

WHY iterate R2 keys (not compute names from results.json): the upload key for an
image is its on-disk filename (`upload_r2.py` uses `p.name`), and duplicate song
titles get a numeric suffix. Re-deriving that mapping for a 70k DESTRUCTIVE
overwrite risks hitting the wrong key. So we walk the bucket's ACTUAL `.webp`
keys: the object we download is both the thing we clean AND the original we back
up, and we upload back to the exact same key — a wrong-key overwrite is
impossible by construction.

Method — two deterministic passes, 100% local, no AI / no API / no token cost:
  1. threshold pass — chords + Thai lyrics are dark & near-neutral ink; the
     watermark (diagonal clef + repeated "Chordtabs" tiling + pale urls) is light
     and/or colored. Keep dark neutral ink (preserving the thin gray strokes of
     small Thai text — the bit a naive binary threshold destroys), whiten the
     rest.
  2. url pass — the dark *italic* "www.chordtabs.in.th" is the same darkness as
     the text, so pass 1 can't touch it. It's a fixed string, so we locate it by
     normalized cross-correlation against a rendered template (multi-scale, two
     italic fonts), restricted to the top-right band where it consistently sits,
     and white out its box. Cut at ncc>=0.40 (measured: real urls 0.57-0.68,
     no-url images <=0.35 — a wide safety gap, so lyrics are never erased).

Validated on 22 random songs across all eras: watermark gone 22/22, zero text
damaged, url removed 10/10 true / 0 false-positive / 0 false-negative.

SAFETY
  * Every original is backed up to  images-orig/<key>  (gitignored) before its
    overwrite — skipped only with --no-backup. We never overwrite without a
    backup on disk first.
  * Resumable: completed keys are appended to logs/dewatermark.done and skipped
    on the next run. Safe to Ctrl-C and re-run.
  * --dry-run does everything EXCEPT the upload (and writes before/after PNGs to
    data/wm-preview-out/ so you can eyeball real R2 images without touching prod).

CACHE NOTE (read before a full run): images are served with
`Cache-Control: public, max-age=31536000, immutable`, and the service worker
caches them CacheFirst. Overwriting a key does NOT reach users who already have
it cached (CDN edge or SW) until that cache is busted. To actually ship clean
images to existing users you'll also need to purge the Cloudflare cache for the
image host AND bump the SW image-cache name. New/uncached opens get the clean
version immediately.

Usage:
  # safe local test on the first 40 real R2 images — NO upload, writes previews:
  scripts/.venv/bin/python scripts/dewatermark.py --dry-run --limit 40

  # real run, first 50 (resumable), with backups:
  scripts/.venv/bin/python scripts/dewatermark.py --limit 50

  # full catalogue:
  scripts/.venv/bin/python scripts/dewatermark.py

Flags:
  --limit N      process only the first N not-yet-done keys
  --start N      skip the first N keys (paired with --limit for batches)
  --dry-run      clean + back up + write previews, but DO NOT upload
  --no-backup    skip the local original backup (not recommended)
  --workers N    parallel GET/clean/PUT jobs (default 12)
  --quality N    output WebP quality (default 80, matches the existing set)
  --no-url       skip pass 2 (threshold only)
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.signal import fftconvolve

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _r2 import BUCKET, make_client  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BACKUP_DIR = ROOT / "images-orig"
LOG_DIR = ROOT / "logs"
DONE_LOG = LOG_DIR / "dewatermark.done"
PREVIEW_DIR = ROOT / "data" / "wm-preview-out"
CACHE_CONTROL = "public, max-age=31536000, immutable"

# ── cleaning core (deterministic, local) ─────────────────────────────────────
T_WHITE, S_MIN, C_MIN = 198.0, 40.0, 95.0   # pass-1 thresholds
LIFT_LO, LIFT_HI = 25.0, 200.0              # contrast lift window for kept ink
URL_STR = "www.chordtabs.in.th"
URL_THRESH = 0.40
_CANDIDATE_FONTS = [
    "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
    "/System/Library/Fonts/Supplemental/Verdana Italic.ttf",
]
URL_FONTS = [f for f in _CANDIDATE_FONTS if os.path.exists(f)]
_TCACHE: dict = {}


def threshold_pass(img: Image.Image) -> np.ndarray:
    """RGB/any PIL image -> 2D uint8 grayscale with the pale/colored watermark
    whitened and the dark+neutral ink (incl. thin gray text strokes) preserved."""
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    L = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    sat = a.max(2) - a.min(2)
    watermark = (L > T_WHITE) | ((sat >= S_MIN) & (L > C_MIN))
    out = np.clip((L - LIFT_LO) / (LIFT_HI - LIFT_LO), 0, 1) * 255.0
    out[watermark] = 255.0
    return out.astype(np.uint8)


def _template(font: str, px: int) -> np.ndarray:
    key = (font, px)
    if key in _TCACHE:
        return _TCACHE[key]
    f = ImageFont.truetype(font, px)
    bb = f.getbbox(URL_STR)
    w, h = bb[2] - bb[0] + 4, bb[3] - bb[1] + 4
    im = Image.new("L", (w, h), 255)
    ImageDraw.Draw(im).text((2 - bb[0], 2 - bb[1]), URL_STR, font=f, fill=0)
    t = 255.0 - np.asarray(im).astype(np.float64)   # ink high
    _TCACHE[key] = t
    return t


def _ncc(region: np.ndarray, t: np.ndarray) -> np.ndarray:
    tz = t - t.mean()
    th, tw = t.shape
    num = fftconvolve(region, tz[::-1, ::-1], mode="valid")
    ones = np.ones((th, tw))
    s = fftconvolve(region, ones, mode="valid")
    s2 = fftconvolve(region ** 2, ones, mode="valid")
    n = th * tw
    var = s2 - s ** 2 / n
    var[var < 0] = 0
    denom = np.sqrt(var) * np.sqrt((tz ** 2).sum())
    out = np.full(num.shape, -1.0)
    nz = denom > 1e-6
    out[nz] = num[nz] / denom[nz]
    return out


def url_pass(gray: np.ndarray, top_frac=0.20, left_frac=0.45,
             thresh=URL_THRESH) -> tuple[np.ndarray, float, tuple]:
    """White out the dark italic url if found in the top-right band.
    Returns (gray_out, best_ncc, (x,y,w,h))."""
    if not URL_FONTS:
        return gray, 0.0, (0, 0, 0, 0)
    H, W = gray.shape
    yb = max(20, int(H * top_frac))
    xb = int(W * left_frac)
    region = 255.0 - gray[:yb, xb:].astype(np.float64)   # ink high
    if region.shape[0] < 10 or region.shape[1] < 30:
        return gray, 0.0, (0, 0, 0, 0)
    base = 14.0 * (W / 620.0)
    scales = sorted({int(round(base * f)) for f in (0.8, 0.9, 1.0, 1.1, 1.2, 1.35)}
                    | set(range(12, 30, 2)))
    best = (-1.0, 0, 0, 0, 0)
    for font in URL_FONTS:
        for px in scales:
            if px < 9:
                continue
            t = _template(font, px)
            th, tw = t.shape
            if th >= region.shape[0] or tw >= region.shape[1]:
                continue
            m = _ncc(region, t)
            j, i = np.unravel_index(np.argmax(m), m.shape)
            if m[j, i] > best[0]:
                best = (float(m[j, i]), int(i) + xb, int(j), tw, th)
    score, x, y, w, h = best
    out = gray
    if score >= thresh:
        out = gray.copy()
        out[max(0, y - 4):y + h + 4, max(0, x - 4):x + w + 7] = 255
    return out, score, (x, y, w, h)


def clean_image(img: Image.Image, do_url=True) -> tuple[Image.Image, float, tuple]:
    g = threshold_pass(img)
    score, box = 0.0, (0, 0, 0, 0)
    if do_url:
        g, score, box = url_pass(g)
    return Image.fromarray(g, "L"), score, box


# ── R2 plumbing ──────────────────────────────────────────────────────────────
def list_image_keys(s3) -> list[str]:
    keys: list[str] = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET):
        for obj in page.get("Contents", []) or []:
            k = obj["Key"]
            if k.lower().endswith(".webp") and "/" not in k:
                keys.append(k)
    keys.sort()
    return keys


def load_done() -> set[str]:
    if not DONE_LOG.exists():
        return set()
    with open(DONE_LOG, encoding="utf-8") as f:
        return {ln.strip() for ln in f if ln.strip()}


_log_lock = threading.Lock()


def mark_done(key: str) -> None:
    with _log_lock:
        with open(DONE_LOG, "a", encoding="utf-8") as f:
            f.write(key + "\n")


def process_key(s3, key: str, args) -> tuple[str, str, float]:
    """Returns (key, status, url_ncc). status in {'clean','url','skip-bad','err:...'}"""
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=key)
        raw = obj["Body"].read()
        try:
            img = Image.open(io.BytesIO(raw))
            img.load()
        except Exception as e:  # noqa: BLE001 — corrupt/non-image object, leave it
            return key, f"skip-bad:{type(e).__name__}", 0.0

        # back up the original bytes before we ever overwrite
        if not args.no_backup:
            bp = BACKUP_DIR / key
            if not bp.exists():
                bp.parent.mkdir(parents=True, exist_ok=True)
                tmp = bp.with_suffix(bp.suffix + ".part")
                tmp.write_bytes(raw)
                tmp.replace(bp)

        cleaned, score, _ = clean_image(img, do_url=not args.no_url)
        buf = io.BytesIO()
        cleaned.save(buf, "WEBP", quality=args.quality, method=6)
        data = buf.getvalue()

        if args.dry_run:
            PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
            W, Hh = img.size
            canvas = Image.new("L", (W * 2 + 8, Hh), 210)
            canvas.paste(img.convert("L"), (0, 0))
            canvas.paste(cleaned.resize((W, Hh)), (W + 8, 0))
            canvas.save(PREVIEW_DIR / (Path(key).stem + ".png"))
        else:
            s3.put_object(Bucket=BUCKET, Key=key, Body=data,
                          ContentType="image/webp", CacheControl=CACHE_CONTROL)
            mark_done(key)
        return key, ("url" if score >= URL_THRESH else "clean"), score
    except Exception as e:  # noqa: BLE001 — best-effort; report + continue
        return key, f"err:{type(e).__name__}: {e}", 0.0


def main() -> None:
    ap = argparse.ArgumentParser(description="De-watermark R2 chord images in place")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--quality", type=int, default=80)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-backup", action="store_true")
    ap.add_argument("--no-url", action="store_true")
    args = ap.parse_args()

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if not URL_FONTS and not args.no_url:
        print("WARN: no italic font found for the url pass — pass 2 will be skipped.")

    s3 = make_client(workers=args.workers)
    print(f"Listing .webp keys in r2://{BUCKET} ...")
    t0 = time.time()
    keys = list_image_keys(s3)
    print(f"  {len(keys):,} image keys ({time.time() - t0:.1f}s)")

    done = set() if args.dry_run else load_done()
    todo = [k for k in keys if k not in done]
    todo = todo[args.start:]
    if args.limit:
        todo = todo[: args.limit]
    if not todo:
        print("nothing to do — all targeted keys already processed.")
        return

    mode = "DRY-RUN (no upload)" if args.dry_run else "LIVE (overwriting R2)"
    print(f"{mode}: {len(todo):,} keys @ {args.workers} workers  "
          f"backup={'OFF' if args.no_backup else str(BACKUP_DIR)}")

    ok = url = bad = err = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process_key, s3, k, args): k for k in todo}
        for n, fut in enumerate(as_completed(futs), 1):
            key, status, score = fut.result()
            if status == "url":
                ok += 1
                url += 1
            elif status == "clean":
                ok += 1
            elif status.startswith("skip-bad"):
                bad += 1
            else:
                err += 1
                print(f"  ! {key}: {status}", flush=True)
            if n % 100 == 0 or n == len(todo):
                el = time.time() - started
                rate = n / el if el else 0
                eta = (len(todo) - n) / rate if rate else 0
                print(f"  [{n:,}/{len(todo):,}] ok={ok:,} url={url:,} bad={bad:,} "
                      f"err={err:,}  {rate:.1f}/s  eta {eta/60:.1f}m", flush=True)

    print(f"\ndone — ok={ok:,} (url removed {url:,}) bad={bad:,} err={err:,} "
          f"in {(time.time()-started)/60:.1f}m")
    if args.dry_run:
        print(f"previews -> {PREVIEW_DIR}")
    else:
        print(f"backups  -> {BACKUP_DIR}\nprogress -> {DONE_LOG} (re-run to resume)")
        print("REMINDER: bust the Cloudflare cache + bump the SW image-cache name "
              "so cached users get the clean images.")


if __name__ == "__main__":
    main()
