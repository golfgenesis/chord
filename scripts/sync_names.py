"""
Sync filenames <-> alt in results.json.

WHEN TO RUN: only at the PNG stage, immediately after `download.py`. The
script expects `.png` files in `images/` and will report 70k "missing"
files if you run it after `convert_to_webp.py` has already replaced
them with `.webp`. The pipeline order is:

    scrape.py → download.py → [sync_names.py] → convert_to_webp.py → upload_r2.py

Rule:
- For duplicate-alt records (file has _{id} suffix): update results.json alt
  to "คอร์ด {cleaned_alt}_{id}" so alt matches filename.
- For non-duplicate records: ensure the file on disk equals "{cleaned_alt}.png".
  Rename file if it doesn't match.

Run modes:
  python sync_names.py --dry-run      # show what would change
  python sync_names.py                # apply changes
"""

import argparse
import json
import os
import re
import shutil
import sys
from collections import Counter
from urllib.parse import urlparse

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

# images/ holds both .png (pre-convert, just downloaded) and .webp (already
# converted by a previous run). The script's job is name-vs-alt consistency,
# which is extension-agnostic — so we match on stem.
IMAGE_EXTS = {".png", ".webp", ".jpg", ".jpeg", ".gif"}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
ARCHIVE_DIR = os.path.join(DATA_DIR, "archive")
os.makedirs(ARCHIVE_DIR, exist_ok=True)
RESULTS_JSON = os.path.join(DATA_DIR, "results.json")
BACKUP_JSON = os.path.join(ARCHIVE_DIR, "results.before_sync.json")
OUT_DIR = os.path.join(PROJECT_ROOT, "images")

INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def clean_alt(alt: str) -> str:
    s = alt
    if s.startswith("คอร์ด "):
        s = s[len("คอร์ด "):]
    s = INVALID.sub("_", s)
    s = re.sub(r"\s+", " ", s).strip().rstrip(". ")
    return s or "untitled"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    with open(RESULTS_JSON, "r", encoding="utf-8") as f:
        records = json.load(f)

    cleaned = [clean_alt(r["alt"]) for r in records]
    counts = Counter(name.lower() for name in cleaned)

    # Snapshot disk contents indexed by lowercase stem (extension-agnostic)
    # so a .webp on disk satisfies a record whose src is .png. Each entry
    # is (lowercase actual filename, actual case filename) so we can detect
    # case-only mismatches without dragging extension into the comparison.
    actual_by_stem: dict[str, str] = {}
    for f in os.listdir(OUT_DIR):
        stem, ext = os.path.splitext(f)
        if ext.lower() in IMAGE_EXTS:
            actual_by_stem[stem.lower()] = f

    alt_updates = []        # (record, old_alt, new_alt)
    file_renames = []       # (record, current_path, target_name)
    missing = []            # record has no file on disk
    name_clashes = []       # rename would collide with another expected name

    expected_names = set()
    plans = []  # (record, cleaned, expected_fname, is_dup)
    for r, name in zip(records, cleaned):
        ext = os.path.splitext(urlparse(r["src"]).path)[1].lower() or ".png"
        is_dup = counts[name.lower()] > 1
        fname = f"{name}_{r['id']}{ext}" if is_dup else f"{name}{ext}"
        expected_names.add(fname.lower())
        plans.append((r, name, fname, is_dup))

    for r, name, fname, is_dup in plans:
        ext = os.path.splitext(fname)[1]
        if is_dup:
            # The filename has _{id}. Update the alt to reflect that.
            desired_alt = f"คอร์ด {name}_{r['id']}"
            if r["alt"] != desired_alt:
                alt_updates.append((r, r["alt"], desired_alt))
        else:
            # Filename stem should be exactly `name` (any image extension).
            expected_stem = name
            actual_fname = actual_by_stem.get(expected_stem.lower())
            if actual_fname is None:
                missing.append((r, fname))
            else:
                actual_stem = os.path.splitext(actual_fname)[0]
                if actual_stem != expected_stem:
                    # Case-only mismatch — rename to the expected casing
                    # while preserving the on-disk extension.
                    actual_ext = os.path.splitext(actual_fname)[1]
                    target_fname = expected_stem + actual_ext
                    file_renames.append((r, actual_fname, target_fname))

    print(f"Records total:              {len(records):,}")
    print(f"Alt updates (dups):         {len(alt_updates):,}")
    print(f"File renames (case fixes):  {len(file_renames):,}")
    print(f"Missing files:              {len(missing):,}")
    print()

    if alt_updates:
        print("Sample alt updates (first 5):")
        for r, old, new in alt_updates[:5]:
            print(f"  id={r['id']:>6}")
            print(f"    old alt: {old!r}")
            print(f"    new alt: {new!r}")
        print()
    if file_renames:
        print("Sample file renames (first 5):")
        for r, cur, tgt in file_renames[:5]:
            print(f"  id={r['id']:>6}  {cur!r}  ->  {tgt!r}")
        print()
    if missing:
        print("Missing files (first 10):")
        for r, fname in missing[:10]:
            print(f"  id={r['id']:>6}  expected {fname!r}")
        print()

    if args.dry_run:
        print("--dry-run: no changes written.")
        return

    # Apply alt updates
    if alt_updates:
        shutil.copy2(RESULTS_JSON, BACKUP_JSON)
        print(f"Backed up original JSON to {BACKUP_JSON}")
        for r, _old, new in alt_updates:
            r["alt"] = new
        with open(RESULTS_JSON, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)
        print(f"Updated alt for {len(alt_updates):,} records in {RESULTS_JSON}")

    # Apply file renames. Two-phase via temp to handle Windows case-only renames.
    renamed = 0
    for r, cur, tgt in file_renames:
        cur_path = os.path.join(OUT_DIR, cur)
        tgt_path = os.path.join(OUT_DIR, tgt)
        if cur_path == tgt_path:
            continue
        tmp_path = cur_path + ".tmprename"
        try:
            os.rename(cur_path, tmp_path)
            os.rename(tmp_path, tgt_path)
            renamed += 1
        except OSError as e:
            print(f"  rename failed id={r['id']}: {e}")
    if file_renames:
        print(f"Renamed {renamed:,} files for case consistency")

    print("Done.")


if __name__ == "__main__":
    main()
