r"""
Verify the chord-image dataset is fully in sync across three places:

  1. data/results.json          (source of truth — what songs SHOULD exist)
  2. F:\chord\images\           (local WebP files)
  3. R2 bucket `chord-images`   (what users actually fetch)

Reports four kinds of mismatch:

  * Missing locally  → convert_to_webp.py never ran for these records
  * Missing on R2    → upload_r2.py needs to run for these records
  * Orphan local     → leftover WebP files no record references (safe to delete)
  * Orphan on R2     → leftover R2 objects no record references (safe to delete)

USAGE

  py F:\chord\scripts\check_sync.py
      Print a report. Exit code 0 if everything matches, 1 otherwise.

  py F:\chord\scripts\check_sync.py --json
      Machine-readable JSON output.

  py F:\chord\scripts\check_sync.py --delete-orphans
      DELETE orphan WebP files locally AND from R2. Asks for confirmation
      unless --yes is also passed.

  py F:\chord\scripts\check_sync.py --delete-orphans --yes
      Same, no prompt. Use carefully.

R2 credentials come from <project_root>/.env.local via scripts/_env.py.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

# Make sibling helpers importable when this script is run from any cwd.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from _r2 import BUCKET, make_client  # noqa: E402

RESULTS_JSON = ROOT / "data" / "results.json"
IMAGES_DIR = ROOT / "images"

# Filename derivation rules — MUST stay in sync with scripts/download.py,
# scripts/sync_names.py, and scripts/build-data.mjs. If any of those
# change their cleaning logic, mirror it here.
INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
PREFIX = "คอร์ด "


def clean_alt(alt: str) -> str:
    s = alt[len(PREFIX):] if alt.startswith(PREFIX) else alt
    s = INVALID.sub("_", s)
    s = re.sub(r"\s+", " ", s).strip().rstrip(". ")
    return s or "untitled"


def expected_webp_filenames() -> set[str]:
    """Build the set of `.webp` filenames every record in results.json
    expects to find — applying the same `_{id}` collision suffix logic
    download.py and build-data.mjs use."""
    records = json.loads(RESULTS_JSON.read_text(encoding="utf-8"))
    cleaned = [clean_alt(r["alt"]) for r in records]
    counts = Counter(name.lower() for name in cleaned)
    out = set()
    for r, name in zip(records, cleaned):
        if counts[name.lower()] > 1:
            out.add(f"{name}_{r['id']}.webp")
        else:
            out.add(f"{name}.webp")
    return out


def list_local_webp() -> set[str]:
    if not IMAGES_DIR.is_dir():
        return set()
    return {
        p.name for p in IMAGES_DIR.iterdir()
        if p.is_file() and p.suffix.lower() == ".webp"
    }


def list_r2_webp(s3) -> set[str]:
    keys = set()
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET):
        for o in page.get("Contents", []) or []:
            if o["Key"].lower().endswith(".webp"):
                keys.add(o["Key"])
    return keys


BOX_W = 62


def hr(char: str = "─") -> str:
    return char * BOX_W


def print_box(text: str) -> None:
    print(f"\n┌{'─' * (BOX_W - 2)}┐")
    print(f"│{text.center(BOX_W - 2)}│")
    print(f"└{'─' * (BOX_W - 2)}┘")


def print_section(text: str) -> None:
    label = f" {text} "
    print(f"\n─── {text} {'─' * (BOX_W - len(label) - 5)}")


def print_row(label: str, value: str, status: str = "") -> None:
    left = f"  {label:<22}{value:>14}"
    print(f"{left}   {status}")


def show_items(items: set[str], limit: int = 10) -> None:
    for x in sorted(items)[:limit]:
        print(f"    {x}")
    if len(items) > limit:
        print(f"    ... and {len(items) - limit:,} more")


def delete_local(orphans: set[str]) -> int:
    deleted = 0
    for name in orphans:
        p = IMAGES_DIR / name
        try:
            p.unlink()
            deleted += 1
        except OSError as e:
            print(f"  could not delete {name}: {e}")
    return deleted


def delete_r2(s3, orphans: set[str]) -> int:
    if not orphans:
        return 0
    keys = sorted(orphans)
    deleted = 0
    for i in range(0, len(keys), 1000):
        batch = keys[i:i + 1000]
        res = s3.delete_objects(
            Bucket=BUCKET,
            Delete={"Objects": [{"Key": k} for k in batch], "Quiet": True},
        )
        errs = res.get("Errors", []) or []
        deleted += len(batch) - len(errs)
        for e in errs[:5]:
            print(f"  R2 delete error: {e}")
    return deleted


def confirm(prompt: str) -> bool:
    try:
        ans = input(prompt + " [y/N]: ").strip().lower()
    except KeyboardInterrupt:
        return False
    return ans in ("y", "yes")


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--json", action="store_true", help="Output machine-readable JSON.")
    p.add_argument(
        "--delete-orphans",
        action="store_true",
        help="Delete orphan WebPs from both local and R2.",
    )
    p.add_argument(
        "--yes",
        action="store_true",
        help="Skip confirmation prompt with --delete-orphans.",
    )
    args = p.parse_args()

    if not RESULTS_JSON.exists():
        sys.exit(f"ERROR: {RESULTS_JSON} not found")

    expected = expected_webp_filenames()
    local = list_local_webp()
    s3 = make_client()
    r2 = list_r2_webp(s3)

    missing_local = expected - local
    missing_r2 = expected - r2
    orphan_local = local - expected
    orphan_r2 = r2 - expected

    report = {
        "expected": len(expected),
        "local": len(local),
        "r2": len(r2),
        "missing_local": sorted(missing_local),
        "missing_r2": sorted(missing_r2),
        "orphan_local": sorted(orphan_local),
        "orphan_r2": sorted(orphan_r2),
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        all_good = not (missing_local or missing_r2 or orphan_local or orphan_r2)

        print_box("Sync check")
        print()
        print_row(
            "data/results.json",
            f"{len(expected):,} records",
            "source of truth",
        )
        local_status = "✓ matches data" if len(local) == len(expected) and not missing_local else (
            f"✗ short by {len(expected) - len(local):,}" if len(local) < len(expected)
            else f"⚠ {len(local) - len(expected):,} extra"
        )
        print_row("images/*.webp", f"{len(local):,} files", local_status)
        r2_status = "✓ matches data" if len(r2) == len(expected) and not missing_r2 else (
            f"✗ short by {len(expected) - len(r2):,}" if len(r2) < len(expected)
            else f"⚠ {len(r2) - len(expected):,} extra"
        )
        print_row("R2 chord-images", f"{len(r2):,} objects", r2_status)

        if missing_local:
            print_section("Missing locally — convert step needs to run")
            show_items(missing_local)
        if missing_r2:
            print_section("Missing on R2 — upload step needs to run")
            show_items(missing_r2)
        if orphan_local:
            print_section("Orphan local files (no record references them)")
            show_items(orphan_local)
        if orphan_r2:
            print_section("Orphan R2 objects (no record references them)")
            show_items(orphan_r2)

        print(f"\n{hr()}")
        if all_good:
            print("  Status: ALL IN SYNC  ✓".center(BOX_W))
        else:
            print("  Status: OUT OF SYNC  ✗".center(BOX_W))
        print(hr())

    if args.delete_orphans and (orphan_local or orphan_r2):
        if not args.yes:
            n = len(orphan_local) + len(orphan_r2)
            if not confirm(f"\nDelete {n:,} orphan WebP file(s)?"):
                print("Aborted.")
                sys.exit(2)
        deleted_local = delete_local(orphan_local)
        deleted_r2 = delete_r2(s3, orphan_r2)
        print(f"\nDeleted: {deleted_local} local, {deleted_r2} R2")

    # Non-zero exit when something is out of sync — handy for CI / git hooks.
    if missing_local or missing_r2 or orphan_local or orphan_r2:
        sys.exit(1)


if __name__ == "__main__":
    main()
