"""
Download all chord images from results.json.

Source format from chordtabs.in.th is PNG; this script saves PNGs to
`images/`. The next step in the pipeline (convert_to_webp.py) replaces
each PNG with a WebP in place and deletes the source. Don't be surprised
when `images/` looks empty of PNGs between runs — that's expected after
conversion.

- Filename = alt with "คอร์ด " prefix stripped, sanitized for Windows
- If multiple records share the same cleaned alt, append "_{id}" to disambiguate
- Saves to OUT_DIR
- Resumable: skips files that already exist (by exact target path)
- Concurrent with a moderate thread pool (images are heavier than HTML)
- Retries failed downloads; logs persistent failures to errors_download.log

Run:
  python download.py --test 2          # try 2 records, print what would happen + actually download them
  python download.py                   # full run
  python download.py --workers 6       # adjust concurrency
"""

import argparse
import json
import os
import re
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests

# chordtabs.in.th returns relative `src` attrs like `/img/nm/c0001234.png`.
# Resolve against this base so the download requests are valid URLs.
SOURCE_BASE_URL = "https://chordtabs.in.th/"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
LOGS_DIR = os.path.join(PROJECT_ROOT, "logs")
os.makedirs(LOGS_DIR, exist_ok=True)
RESULTS_JSON = os.path.join(DATA_DIR, "results.json")
ERRORS_PATH = os.path.join(LOGS_DIR, "download_errors.log")
OUT_DIR = os.path.join(PROJECT_ROOT, "images")

WORKERS = 8
REQUEST_TIMEOUT = 30
RETRIES = 2
CHUNK = 64 * 1024

INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
err_lock = threading.Lock()


def log_error(msg):
    with err_lock:
        with open(ERRORS_PATH, "a", encoding="utf-8") as f:
            f.write(msg + "\n")


def clean_alt(alt: str) -> str:
    """Strip the 'คอร์ด ' prefix, collapse whitespace, sanitize for Windows."""
    s = alt
    if s.startswith("คอร์ด "):
        s = s[len("คอร์ด "):]
    s = INVALID_CHARS.sub("_", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = s.rstrip(". ")  # Windows hates trailing dots/spaces
    if not s:
        s = "untitled"
    return s


def build_targets(records):
    """Compute final filename per record, suffixing _{id} on collision.
    Uses case-insensitive comparison because Windows treats 'Abc.png' and
    'ABC.png' as the same file."""
    cleaned = [clean_alt(r["alt"]) for r in records]
    counts = Counter(name.lower() for name in cleaned)
    targets = []
    for r, name in zip(records, cleaned):
        ext = os.path.splitext(urlparse(r["src"]).path)[1].lower() or ".png"
        if counts[name.lower()] > 1:
            fname = f"{name}_{r['id']}{ext}"
        else:
            fname = f"{name}{ext}"
        # Cap component length conservatively (Windows MAX_PATH is 260 by default;
        # OneDrive paths are long, so keep the filename modest)
        if len(fname) > 180:
            keep = 180 - len(ext) - 1 - len(str(r["id"]))
            fname = f"{name[:keep]}_{r['id']}{ext}"
        targets.append((r, fname))
    return targets


def make_session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        ),
        "Accept": "image/avif,image/webp,image/png,image/*,*/*;q=0.8",
        "Accept-Language": "th,en;q=0.8",
        "Referer": "https://chordtabs.in.th/",
    })
    return s


def download_one(session, record, fname, out_dir, existing_stems):
    # Skip if any file with this stem already exists — handles both the
    # PNG (mid-pipeline) and WebP (post-convert) cases without re-downloading.
    stem = os.path.splitext(fname)[0]
    if stem in existing_stems:
        return ("skip", record["id"], stem)

    out_path = os.path.join(out_dir, fname)
    url = urljoin(SOURCE_BASE_URL, record["src"])
    tmp_path = out_path + ".part"
    last_err = None
    for attempt in range(RETRIES + 1):
        try:
            with session.get(url, timeout=REQUEST_TIMEOUT, stream=True) as r:
                if r.status_code == 404:
                    return ("404", record["id"], url)
                r.raise_for_status()
                with open(tmp_path, "wb") as f:
                    for chunk in r.iter_content(CHUNK):
                        if chunk:
                            f.write(chunk)
            os.replace(tmp_path, out_path)
            return ("ok", record["id"], out_path)
        except (requests.RequestException, OSError) as e:
            last_err = e
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass
            time.sleep(0.5 * (attempt + 1))
    log_error(f"id={record['id']} url={url} fname={fname} error={last_err}")
    return ("fail", record["id"], str(last_err))


def run(test_n=None, workers=WORKERS):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(RESULTS_JSON, "r", encoding="utf-8") as f:
        records = json.load(f)

    targets = build_targets(records)
    if test_n is not None:
        targets = targets[:test_n]
        print(f"--- TEST MODE: downloading first {len(targets)} record(s) ---")
        for r, fname in targets:
            print(f"  id={r['id']:>6}  src={r['src']}")
            print(f"             -> {os.path.join(OUT_DIR, fname)}")
        print()

    # Snapshot every existing stem in OUT_DIR once — used to skip records
    # we already have on disk (either as .png or .webp). One listdir is
    # vastly cheaper than 70k filesystem stat() calls inside workers.
    existing_stems = {p.stem for p in Path(OUT_DIR).iterdir() if p.is_file()}
    pending = [(r, fname) for r, fname in targets
               if os.path.splitext(fname)[0] not in existing_stems]

    print(f"Output dir: {OUT_DIR}")
    print(f"Already on disk: {len(existing_stems):,}")
    print(f"Total in results.json: {len(targets):,}")
    print(f"To download: {len(pending):,}")
    print(f"Workers: {workers}")
    print()

    if not pending:
        print("Nothing to download.")
        return

    session = make_session()
    counts = {"ok": 0, "skip": 0, "fail": 0, "404": 0}
    started = time.time()
    done = 0

    try:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(download_one, session, r, fname, OUT_DIR, existing_stems): (r, fname)
                    for r, fname in pending}
            for fut in as_completed(futs):
                r, fname = futs[fut]
                status, ident, info = fut.result()
                counts[status] = counts.get(status, 0) + 1
                done += 1
                if test_n is not None or done % 200 == 0 or done == len(pending):
                    elapsed = time.time() - started
                    rate = done / elapsed if elapsed else 0
                    eta = (len(pending) - done) / rate if rate else 0
                    print(
                        f"[{done:,}/{len(pending):,}] "
                        f"ok={counts['ok']} skip={counts['skip']} "
                        f"fail={counts.get('fail',0)} 404={counts.get('404',0)} "
                        f"rate={rate:.1f}/s eta={eta/60:.1f}min",
                        flush=True,
                    )
                if test_n is not None:
                    print(f"  -> {status}: {info}")
    except KeyboardInterrupt:
        print("\nInterrupted. Partial downloads kept (resumable).")
        return

    elapsed = time.time() - started
    print()
    print(f"Done in {elapsed/60:.1f} min — "
          f"ok={counts['ok']:,}  skip={counts['skip']:,}  "
          f"fail={counts.get('fail',0):,}  404={counts.get('404',0):,}")
    if counts.get("fail", 0):
        print(f"See {ERRORS_PATH} for failed records — re-running will retry them.")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--test", type=int, default=None,
                   help="Only process first N records (smoke test)")
    p.add_argument("--workers", type=int, default=WORKERS)
    args = p.parse_args()
    run(test_n=args.test, workers=args.workers)


if __name__ == "__main__":
    main()
