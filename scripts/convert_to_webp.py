r"""
Convert F:\chord\images\*.png to F:\chord\images\*.webp IN-PLACE.

After a successful WebP write the source PNG is deleted, so the dataset
ends up as a pure-WebP set (~50% smaller). PNGs are not preserved — make
sure data/results.json is intact (we can re-scrape and re-download if
needed) before running.

Why: serving PNG chord sheets directly costs ~70 KB per sheet (~4.9 GB
for 70k). Near-lossless WebP at quality 80 shrinks each file ~40-60%
(~2.5 GB total) with no visible difference on chord sheets (flat colors
+ high-contrast text — the case WebP handles best). And the client-side
SW transcode that USED to do this work was the dominant bottleneck for
bulk offline-download.

Resumable + concurrent. Skips any name where .webp already exists. Safe
to Ctrl-C and rerun.

Setup (one-time):
  1. Download cwebp from https://developers.google.com/speed/webp/download
  2. Unzip; put `cwebp.exe` somewhere on your PATH (or set the CWEBP env
     var to the full path).

Usage (PowerShell):
  py F:\chord\scripts\convert_to_webp.py

Optional flags:
  --dir       directory to walk (default F:\chord\images)
  --quality   near-lossless quality 0..100 (default 80)
  --workers   parallel encode jobs (default = number of CPU cores)
  --limit     convert only the first N files (smoke-test)
  --keep-png  KEEP the source PNG after conversion (default is to delete it)
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Make sibling helpers importable when this script is run from any cwd, then
# pull CWEBP (and anything else) out of .env.local before find_cwebp() runs.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _env import load_env  # noqa: E402
load_env()

try:
    from tqdm import tqdm
except ImportError:
    tqdm = None  # type: ignore[assignment]


# Common Windows install locations for libwebp — checked after $env:CWEBP
# and PATH, so a user who unzipped libwebp to any of these doesn't need to
# touch their environment at all.
CWEBP_FALLBACK_PATHS = (
    r"C:\tools\libwebp\bin\cwebp.exe",
    r"C:\Program Files\libwebp\bin\cwebp.exe",
    r"C:\libwebp\bin\cwebp.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\libwebp\bin\cwebp.exe"),
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Convert chord-sheet PNGs to WebP in place")
    p.add_argument(
        "--dir",
        dest="image_dir",
        default=r"F:\chord\images",
        help="Directory containing the .png files (output goes here too)",
    )
    p.add_argument(
        "--quality",
        type=int,
        default=80,
        help="Near-lossless quality 0-100 (default 80 — visually identical for text/line art)",
    )
    p.add_argument(
        "--workers",
        type=int,
        default=os.cpu_count() or 4,
        help=f"Parallel encode jobs (default: number of CPU cores = {os.cpu_count()})",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Convert only the first N files (for testing)",
    )
    p.add_argument(
        "--keep-png",
        action="store_true",
        help="Keep the source PNG after conversion (default: delete it to reclaim disk).",
    )
    return p.parse_args()


def find_cwebp() -> str:
    """Locate the cwebp binary — env var override, PATH lookup, common install
    paths, then bail."""
    env = os.environ.get("CWEBP")
    if env:
        if Path(env).exists():
            return env
        sys.exit(f"ERROR: CWEBP env var set to '{env}' but that path doesn't exist.")
    found = shutil.which("cwebp")
    if found:
        return found
    for candidate in CWEBP_FALLBACK_PATHS:
        if Path(candidate).exists():
            return candidate
    sys.exit(
        "ERROR: cwebp not found on PATH or in any common install location.\n"
        "  Install: https://developers.google.com/speed/webp/download\n"
        "  Or set CWEBP in .env.local to the full path to cwebp.exe."
    )


def convert_one(
    cwebp: str, src: Path, dst: Path, quality: int, delete_src: bool
) -> tuple[str, str | None]:
    """Run cwebp on a single file, optionally delete the source PNG.

    Returns (filename, error-or-None). We only delete the PNG once we've
    confirmed the .webp exists with size > 0 — better to leave both than
    risk wiping the source on a corrupt encode.
    """
    try:
        # `-near_lossless N` triggers near-lossless mode: tiny smoothing on
        # uniform regions, preserves edges/text. `-q N` controls how
        # aggressive the smoothing gets. `-mt` enables per-file multi-
        # threading. `-quiet` keeps the terminal clean during 70k runs.
        result = subprocess.run(
            [
                cwebp,
                "-near_lossless",
                str(quality),
                "-q",
                str(quality),
                "-mt",
                "-quiet",
                str(src),
                "-o",
                str(dst),
            ],
            capture_output=True,
            # cwebp can write non-ASCII (Thai filenames) into stderr on
            # warnings/errors. Without an explicit `encoding=utf-8`,
            # subprocess falls back to the Windows ANSI code page
            # (cp874 here) and throws UnicodeDecodeError on any byte the
            # CP doesn't know — turning a successful warning into a
            # fake failure. `errors='replace'` covers anything still
            # mis-encoded by cwebp itself.
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        if result.returncode != 0:
            # `result.stderr` is normally a str (capture_output=True + text=True)
            # but defensive: cwebp on Windows occasionally returns None on
            # weird encodes (the 8 transient failures we saw on the first
            # 70k pass were all this exact case).
            err_text = (result.stderr or "").strip()[:120]
            return src.name, f"exit {result.returncode}: {err_text}"
        # Belt-and-braces verification before deleting the source.
        try:
            if not dst.exists() or dst.stat().st_size <= 0:
                return src.name, "encode produced empty output"
        except OSError as e:
            return src.name, f"stat failed: {e}"
        if delete_src:
            try:
                src.unlink()
            except OSError as e:
                # Encode succeeded; we couldn't delete. Leave the PNG and
                # carry on — it's not a fatal failure.
                return src.name, f"converted but couldn't delete source: {e}"
        return src.name, None
    except subprocess.TimeoutExpired:
        return src.name, "timeout (60s)"
    except Exception as e:
        return src.name, f"{type(e).__name__}: {e}"


def main() -> None:
    args = parse_args()
    cwebp = find_cwebp()
    delete_src = not args.keep_png

    image_dir = Path(args.image_dir)
    if not image_dir.is_dir():
        sys.exit(f"ERROR: directory not found: {image_dir}")

    # Resume support: only convert PNGs whose .webp counterpart doesn't
    # exist (or is empty) yet.
    all_pngs = sorted(p for p in image_dir.iterdir() if p.suffix.lower() == ".png")
    if not all_pngs:
        print(f"No .png files left in {image_dir} — nothing to convert.")
        return
    print(f"Found {len(all_pngs):,} PNGs in {image_dir}")

    todo: list[tuple[Path, Path]] = []
    skipped = 0
    for src in all_pngs:
        dst = image_dir / (src.stem + ".webp")
        if dst.exists() and dst.stat().st_size > 0:
            # Webp already exists. If user requested deletion, clean up the
            # stale PNG too so the resume cleanup is consistent.
            if delete_src:
                try:
                    src.unlink()
                except OSError:
                    pass
            skipped += 1
            continue
        todo.append((src, dst))

    if args.limit > 0:
        todo = todo[: args.limit]

    print(f"Already converted: {skipped:,}")
    print(f"To convert:        {len(todo):,}")
    if delete_src:
        print("Source PNG will be DELETED after each successful encode.")
    else:
        print("Source PNG will be KEPT (--keep-png).")
    if not todo:
        return

    print(
        f"Encoding with cwebp ({cwebp}) at near_lossless q={args.quality}, "
        f"{args.workers} parallel jobs ..."
    )
    started = time.time()
    ok = fail = 0
    errors: list[tuple[str, str]] = []
    out_bytes = 0

    iterator = tqdm(total=len(todo), unit="file", smoothing=0.05) if tqdm else None

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {
            ex.submit(convert_one, cwebp, s, d, args.quality, delete_src): (s, d)
            for s, d in todo
        }
        for fut in as_completed(futures):
            src, dst = futures[fut]
            name, err = fut.result()
            if err:
                fail += 1
                errors.append((name, err))
            else:
                ok += 1
                try:
                    out_bytes += dst.stat().st_size
                except OSError:
                    pass
            if iterator:
                iterator.update(1)
            elif (ok + fail) % 500 == 0:
                elapsed = time.time() - started
                rate = (ok + fail) / elapsed if elapsed else 0
                eta = (len(todo) - ok - fail) / rate if rate else 0
                print(
                    f"  [{ok + fail:>6,}/{len(todo):,}]  ok={ok:,}  fail={fail:,}  "
                    f"rate={rate:.1f}/s  eta={eta / 60:.1f}min",
                    flush=True,
                )

    if iterator:
        iterator.close()

    elapsed = time.time() - started
    print(f"\nDone in {elapsed / 60:.1f} min — ok={ok:,}  fail={fail:,}")
    if out_bytes:
        print(f"  Total WebP output: {out_bytes / 1024 / 1024:,.1f} MB")

    if errors:
        log = image_dir.parent / "logs" / "convert_to_webp_errors.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with open(log, "w", encoding="utf-8") as f:
            for name, msg in errors:
                f.write(f"{name}\t{msg}\n")
        print(f"\nErrors logged to {log}")
        print("Re-run the script to retry failed files (resume-safe).")


if __name__ == "__main__":
    main()
