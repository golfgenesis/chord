"""
Upload F:\\chord\\images to Cloudflare R2 bucket `chord-images`.

Resumable + incremental — lists what's already in R2 first, only uploads new files.
Concurrent uploads (16 threads by default). Sets long cache headers.

Usage (in PowerShell):

    pip install boto3 tqdm

    $env:R2_ACCESS_KEY = "your-access-key"
    $env:R2_SECRET_KEY = "your-secret-key"
    python F:\\chord\\scripts\\upload_r2.py
"""

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import boto3
    from botocore.config import Config
except ImportError:
    print("ERROR: boto3 not installed. Run: pip install boto3")
    sys.exit(1)

# ---- Config -----------------------------------------------------------------
ENDPOINT = "https://10eeeb9ff10ab208fccf3479cdde6c19.r2.cloudflarestorage.com"
BUCKET = "chord-images"
LOCAL_DIR = Path(r"F:\chord\images")
WORKERS = 16
CACHE_CONTROL = "public, max-age=31536000, immutable"

ACCESS_KEY = os.environ.get("R2_ACCESS_KEY", "")
SECRET_KEY = os.environ.get("R2_SECRET_KEY", "")
if not ACCESS_KEY or not SECRET_KEY:
    print("ERROR: Set R2_ACCESS_KEY and R2_SECRET_KEY env vars first.")
    print('Example: $env:R2_ACCESS_KEY = "..."; $env:R2_SECRET_KEY = "..."')
    sys.exit(1)

# ---- Client -----------------------------------------------------------------
s3 = boto3.client(
    "s3",
    endpoint_url=ENDPOINT,
    aws_access_key_id=ACCESS_KEY,
    aws_secret_access_key=SECRET_KEY,
    region_name="auto",
    config=Config(
        max_pool_connections=WORKERS * 2,
        retries={"max_attempts": 5, "mode": "adaptive"},
        s3={"addressing_style": "path"},
    ),
)

# ---- List existing files in R2 ---------------------------------------------
print(f"Listing existing objects in r2://{BUCKET} ...")
existing: set[str] = set()
paginator = s3.get_paginator("list_objects_v2")
t0 = time.time()
for page in paginator.paginate(Bucket=BUCKET):
    for obj in page.get("Contents", []) or []:
        existing.add(obj["Key"])
print(f"  found {len(existing):,} files in R2 ({time.time()-t0:.1f}s)")

# ---- List local files -------------------------------------------------------
if not LOCAL_DIR.is_dir():
    print(f"ERROR: {LOCAL_DIR} not found")
    sys.exit(1)

local_files = [p for p in LOCAL_DIR.iterdir() if p.is_file()]
print(f"Local: {len(local_files):,} files in {LOCAL_DIR}")

to_upload = [p for p in local_files if p.name not in existing]
already = len(local_files) - len(to_upload)
print(f"Already in R2: {already:,}")
print(f"To upload:     {len(to_upload):,}")

if not to_upload:
    print("Nothing to do. Bucket is already in sync with local.")
    sys.exit(0)


# ---- Upload -----------------------------------------------------------------
CONTENT_TYPES = {
    ".png": "image/png",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}


def upload(p: Path) -> tuple[str, str | None]:
    content_type = CONTENT_TYPES.get(p.suffix.lower(), "application/octet-stream")
    try:
        s3.upload_file(
            str(p),
            BUCKET,
            p.name,
            ExtraArgs={
                "ContentType": content_type,
                "CacheControl": CACHE_CONTROL,
            },
        )
        return p.name, None
    except Exception as e:
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
        if i % 100 == 0 or i == len(to_upload):
            elapsed = time.time() - started
            rate = i / elapsed if elapsed else 0
            eta = (len(to_upload) - i) / rate if rate else 0
            print(
                f"  [{i:>6,}/{len(to_upload):,}]  ok={ok:,}  fail={fail:,}  "
                f"rate={rate:.1f}/s  eta={eta/60:.1f}min",
                flush=True,
            )

elapsed = time.time() - started
print(f"\nDone in {elapsed/60:.1f} min — ok={ok:,}  fail={fail:,}")

if errors:
    log_path = LOCAL_DIR.parent / "logs" / "upload_r2_errors.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w", encoding="utf-8") as f:
        for name, err in errors:
            f.write(f"{name}\t{err}\n")
    print(f"Errors logged to {log_path}")
    print("Re-run the script to retry failed uploads (resume-safe).")
