"""
Sync filenames <-> alt in results.json.

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
from collections import Counter
from urllib.parse import urlparse

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

    # Snapshot disk contents (case-insensitive index -> actual filename)
    actual_files = {f.lower(): f for f in os.listdir(OUT_DIR)}

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
            # Filename should be exactly {cleaned}.png. Check disk.
            target_lower = fname.lower()
            if target_lower in actual_files:
                actual = actual_files[target_lower]
                if actual != fname:
                    # Same case-insensitive name but different case — rename for consistency.
                    file_renames.append((r, actual, fname))
            else:
                missing.append((r, fname))

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
