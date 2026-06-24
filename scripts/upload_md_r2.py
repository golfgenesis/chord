r"""
Upload ChordPro markdown sheets to Cloudflare R2 (alongside the WebP images).

Source:  data/songs-md/<id>.md      (produced by scripts/gemini-backfill.mjs)
Dest:    r2://<bucket>/md/<id>.md    (served by the same R2 Custom Domain)

The client fetches  ${VITE_IMAGE_BASE}/md/<id>.md  at view time and the service
worker caches it stale-while-revalidate for offline. Keeping the text on R2 (not
in the Cloudflare Pages deploy) keeps us clear of the Pages file-count limit and
keeps public/songs.bin tiny.

Resumable + incremental — lists what's already under md/ in R2 first and only
uploads new / changed files (size mismatch). Concurrent (16 threads).

R2 credentials come from <project_root>/.env.local (R2_ACCESS_KEY / R2_SECRET_KEY).

    pip install boto3
    py -3.11 scripts/upload_md_r2.py
    py -3.11 scripts/upload_md_r2.py --force   # re-upload everything
"""

import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _r2 import BUCKET, make_client  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
LOCAL_DIR = ROOT / "data" / "songs-md"
KEY_PREFIX = "md/"
WORKERS = 16
# md files change when a song is re-extracted, so do NOT mark them immutable.
# A short TTL lets fixes propagate; the service worker's SWR does the heavy
# lifting for instant offline serving.
CACHE_CONTROL = "public, max-age=3600"
CONTENT_TYPE = "text/markdown; charset=utf-8"
FORCE = "--force" in sys.argv

if not LOCAL_DIR.is_dir():
    sys.exit(f"ERROR: {LOCAL_DIR} not found — run the backfill first.")

s3 = make_client(workers=WORKERS)

# ---- list existing md/ objects (key -> size) -------------------------------
print(f"Listing existing objects under r2://{BUCKET}/{KEY_PREFIX} ...")
existing: dict[str, int] = {}
paginator = s3.get_paginator("list_objects_v2")
t0 = time.time()
for page in paginator.paginate(Bucket=BUCKET, Prefix=KEY_PREFIX):
    for obj in page.get("Contents", []) or []:
        existing[obj["Key"]] = obj["Size"]
print(f"  found {len(existing):,} files ({time.time() - t0:.1f}s)")

# ---- local md files --------------------------------------------------------
local_files = sorted(p for p in LOCAL_DIR.iterdir() if p.is_file() and p.suffix == ".md")
print(f"Local: {len(local_files):,} .md files in {LOCAL_DIR}")


def needs_upload(p: Path) -> bool:
    if FORCE:
        return True
    key = KEY_PREFIX + p.name
    return existing.get(key) != p.stat().st_size  # missing or size changed


to_upload = [p for p in local_files if needs_upload(p)]
print(f"Already in sync: {len(local_files) - len(to_upload):,}")
print(f"To upload:       {len(to_upload):,}")
if not to_upload:
    print("Nothing to do.")
    sys.exit(0)


def upload(p: Path) -> tuple[str, str | None]:
    try:
        s3.upload_file(
            str(p),
            BUCKET,
            KEY_PREFIX + p.name,
            ExtraArgs={"ContentType": CONTENT_TYPE, "CacheControl": CACHE_CONTROL},
        )
        return p.name, None
    except Exception as e:  # noqa: BLE001
        return p.name, f"{type(e).__name__}: {e}"


print(f"\nUploading {len(to_upload):,} files with {WORKERS} workers...")
ok = fail = 0
started = time.time()
errors: list[tuple[str, str]] = []
with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    futures = {ex.submit(upload, p): p for p in to_upload}
    for i, fut in enumerate(as_completed(futures), 1):
        name, err = fut.result()
        if err:
            fail += 1
            errors.append((name, err))
        else:
            ok += 1
        if i % 200 == 0 or i == len(to_upload):
            el = time.time() - started
            rate = i / el if el else 0
            print(f"  [{i:>6,}/{len(to_upload):,}]  ok={ok:,}  fail={fail:,}  rate={rate:.1f}/s", flush=True)

print(f"\nDone in {(time.time() - started) / 60:.1f} min — ok={ok:,}  fail={fail:,}")
if errors:
    log_path = ROOT / "logs" / "upload_md_r2_errors.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w", encoding="utf-8") as f:
        for name, err in errors:
            f.write(f"{name}\t{err}\n")
    print(f"Errors logged to {log_path} — re-run to retry (resume-safe).")
