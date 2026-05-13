"""
Cross-check songs.json against the R2 bucket `chord-images`.

Reports:
  1. Entries in songs.json whose `file` is NOT in R2  (these need uploading)
  2. Entries whose `file` IS in the local images dir  (you can re-run upload_r2.py)
     vs. those missing locally too (you'll need to source them)
  3. Orphan files on R2 not referenced by songs.json  (informational)

Usage (PowerShell):

    pip install boto3

    $env:R2_ACCESS_KEY = "762ccd9d6c0bfdd7a0fc516846fe4b04"
    $env:R2_SECRET_KEY = "ce0e47cdbd3f2782658dac42e3c6538628770063aa0f3c41a48cdc696e0f4691"
    python F:\\chord\\scripts\\check_missing.py
"""

import json
import os
import sys
import time
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
SONGS_JSON = Path(r"F:\chord\public\songs.json")
REPORT_DIR = Path(r"F:\chord\logs")

ACCESS_KEY = os.environ.get("R2_ACCESS_KEY", "")
SECRET_KEY = os.environ.get("R2_SECRET_KEY", "")
if not ACCESS_KEY or not SECRET_KEY:
    print("ERROR: Set R2_ACCESS_KEY and R2_SECRET_KEY env vars first.")
    sys.exit(1)

# ---- Load songs.json --------------------------------------------------------
if not SONGS_JSON.is_file():
    print(f"ERROR: {SONGS_JSON} not found")
    sys.exit(1)

songs = json.loads(SONGS_JSON.read_text(encoding="utf-8"))
print(f"songs.json: {len(songs):,} entries  ({SONGS_JSON})")

# Build {file_name: song} — first occurrence wins; record duplicates
referenced: dict[str, dict] = {}
dupes: list[dict] = []
no_file_field: list[dict] = []
for s in songs:
    fname = s.get("file")
    if not fname:
        no_file_field.append(s)
        continue
    if fname in referenced:
        dupes.append(s)
    else:
        referenced[fname] = s

# ---- List R2 ----------------------------------------------------------------
s3 = boto3.client(
    "s3",
    endpoint_url=ENDPOINT,
    aws_access_key_id=ACCESS_KEY,
    aws_secret_access_key=SECRET_KEY,
    region_name="auto",
    config=Config(retries={"max_attempts": 5, "mode": "adaptive"},
                  s3={"addressing_style": "path"}),
)

print(f"Listing r2://{BUCKET} ...")
t0 = time.time()
in_r2: set[str] = set()
for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET):
    for obj in page.get("Contents", []) or []:
        in_r2.add(obj["Key"])
print(f"  R2: {len(in_r2):,} objects ({time.time()-t0:.1f}s)")

# ---- List local images ------------------------------------------------------
on_disk: set[str] = set()
if LOCAL_DIR.is_dir():
    on_disk = {p.name for p in LOCAL_DIR.iterdir() if p.is_file()}
print(f"Local ({LOCAL_DIR}): {len(on_disk):,} files")

# ---- Compute deltas ---------------------------------------------------------
needed_files = set(referenced.keys())
missing_on_r2 = needed_files - in_r2
missing_locally = needed_files - on_disk
missing_everywhere = missing_on_r2 & (needed_files - on_disk)
missing_only_r2 = missing_on_r2 - missing_locally  # local has, R2 doesn't
orphans_on_r2 = in_r2 - needed_files

# ---- Report -----------------------------------------------------------------
print()
print("=" * 70)
print(f"songs.json entries:       {len(songs):,}")
print(f"  unique files referenced: {len(referenced):,}")
print(f"  duplicate `file`:        {len(dupes):,}")
print(f"  missing `file` field:    {len(no_file_field):,}")
print(f"R2 objects:               {len(in_r2):,}")
print(f"Local files:              {len(on_disk):,}")
print("-" * 70)
print(f"Missing on R2:            {len(missing_on_r2):,}")
print(f"  -> local has it (just re-run upload_r2.py): {len(missing_only_r2):,}")
print(f"  -> missing locally too (need to source):    {len(missing_everywhere):,}")
print(f"Orphan files on R2 (not in songs.json):       {len(orphans_on_r2):,}")
print("=" * 70)

# ---- Show the actually-missing entries --------------------------------------
if missing_on_r2:
    print("\nMissing on R2 — entries that need uploading:")
    for fname in sorted(missing_on_r2):
        s = referenced[fname]
        where = "[LOCAL OK]" if fname in on_disk else "[NOT LOCAL]"
        print(f"  {where}  id={s.get('id'):>6}  {fname}")

if no_file_field:
    print(f"\nEntries with no `file` field ({len(no_file_field)}):")
    for s in no_file_field[:20]:
        print(f"  id={s.get('id')}  name={s.get('name')!r}")

if dupes:
    print(f"\nDuplicate `file` references ({len(dupes)}, showing first 20):")
    for s in dupes[:20]:
        print(f"  id={s.get('id')}  file={s.get('file')!r}")

# ---- Write report files -----------------------------------------------------
REPORT_DIR.mkdir(parents=True, exist_ok=True)

missing_path = REPORT_DIR / "missing_on_r2.txt"
with missing_path.open("w", encoding="utf-8") as f:
    for fname in sorted(missing_on_r2):
        s = referenced[fname]
        where = "LOCAL" if fname in on_disk else "MISSING_LOCAL"
        f.write(f"{where}\t{s.get('id')}\t{fname}\n")
print(f"\nWrote {missing_path}")

orphans_path = REPORT_DIR / "orphans_on_r2.txt"
with orphans_path.open("w", encoding="utf-8") as f:
    for k in sorted(orphans_on_r2):
        f.write(k + "\n")
print(f"Wrote {orphans_path}")
