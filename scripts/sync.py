r"""
One-stop pipeline: probe source → scrape new pages → download → convert
→ upload → verify → rebuild songs.bin → (optional) git commit + push.

Each step shells out to the existing per-step script, so they remain
independently runnable + testable. Every step is also resumable: skips
work already done, so running this twice is cheap.

USAGE

  py F:\chord\scripts\sync.py
      Probe chordtabs.in.th for the new ceiling (starts at max id in
      results.json + 1; stops after 10 consecutive misses), then runs
      the full pipeline.

  py F:\chord\scripts\sync.py --end 70599
      Skip the probe — scrape exactly up to 70599.

  py F:\chord\scripts\sync.py --start 70570 --end 70599
      Force a specific start id too.

  py F:\chord\scripts\sync.py --skip-upload --skip-push
      Local-only run, no R2 / no git.

  py F:\chord\scripts\sync.py --push
      Also git-commit + push the rebuilt songs.bin at the very end.

  py F:\chord\scripts\sync.py --dry-run
      Print every step's command without running anything (also skips
      the probe).

PREREQUISITES (one-time)

  - py -m pip install requests beautifulsoup4 lxml boto3 tqdm
  - cwebp on PATH or `CWEBP` env var pointing at the binary
  - R2_ACCESS_KEY / R2_SECRET_KEY in <project_root>/.env.local
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

# Windows consoles default to cp1252 which can't print the Thai / arrow
# glyphs in some step names — force utf-8 so dry-run + progress logging
# survive on a stock PowerShell.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
RESULTS_JSON = ROOT / "data" / "results.json"
IMAGES_DIR = ROOT / "images"

SOURCE_URL = "https://chordtabs.in.th/{id}/"
PROBE_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
PROBE_MISS_THRESHOLD = 100   # stop after N consecutive misses
PROBE_MAX_LOOKAHEAD = 1000  # absolute safety ceiling per run


# ---- helpers ---------------------------------------------------------------

class Step:
    def __init__(self, name: str, cmd: list, optional: bool = False):
        self.name = name
        self.cmd = [str(c) for c in cmd]
        self.optional = optional


BOX_W = 62


def print_header(text: str) -> None:
    inner = text.center(BOX_W - 2)
    print(f"\n┌{'─' * (BOX_W - 2)}┐", flush=True)
    print(f"│{inner}│", flush=True)
    print(f"└{'─' * (BOX_W - 2)}┘", flush=True)


def print_step(i: int, total: int, name: str) -> None:
    print(f"\n[{i}/{total}] {name}", flush=True)


def probe_source_end(start: int) -> int:
    """Walk chordtabs.in.th sequentially from `start`, returning the
    highest id that exposes a chord image. Stops once we've seen
    PROBE_MISS_THRESHOLD ids in a row without one. Falls back to
    `start - 1` if nothing new is up there yet.
    """
    import requests
    from bs4 import BeautifulSoup

    # Reuse scrape.py's predicate for "is this a real chord image" so the
    # probe doesn't burn the safety ceiling on placeholder pages.
    sys.path.insert(0, str(SCRIPTS))
    from scrape import looks_like_real_image  # noqa: E402

    session = requests.Session()
    session.headers.update({"User-Agent": PROBE_USER_AGENT})

    print(f"  start id          : {start:,}")
    print(f"  stop after        : {PROBE_MISS_THRESHOLD} consecutive misses")
    print(f"  safety ceiling    : start + {PROBE_MAX_LOOKAHEAD:,}\n", flush=True)

    last_hit = start - 1
    consecutive = 0
    hits = 0

    for page_id in range(start, start + PROBE_MAX_LOOKAHEAD + 1):
        has_image = False
        try:
            r = session.get(SOURCE_URL.format(id=page_id), timeout=20)
            if r.status_code != 404:
                soup = BeautifulSoup(r.text, "lxml")
                div = soup.find(id="divlyric")
                img = div.find("img") if div else None
                has_image = bool(img and looks_like_real_image(img.get("src")))
        except requests.RequestException as e:
            print(f"  !  {page_id:>6}  network error: {e}", flush=True)

        if has_image:
            hits += 1
            consecutive = 0
            last_hit = page_id
            print(f"  ✓  {page_id:>6}  found  (hits so far: {hits})", flush=True)
        else:
            consecutive += 1
            print(
                f"  ✗  {page_id:>6}  no image  "
                f"({consecutive}/{PROBE_MISS_THRESHOLD} consecutive)",
                flush=True,
            )
            if consecutive >= PROBE_MISS_THRESHOLD:
                print(f"\n  → stopping ({PROBE_MISS_THRESHOLD} consecutive misses)")
                break
    else:
        print(
            f"\n  ! hit safety ceiling at start + {PROBE_MAX_LOOKAHEAD}"
            f" — re-run if you suspect more pages exist."
        )

    if last_hit < start:
        print("\n  Nothing new at source yet.")
    else:
        print(
            f"\n  Highest id with chord image: {last_hit:,}  "
            f"({hits} new page{'s' if hits != 1 else ''})"
        )
    return last_hit


def latest_scraped_id() -> int:
    """Largest id in data/results.json — used as the default `--start`."""
    if not RESULTS_JSON.exists():
        return 0
    try:
        records = json.loads(RESULTS_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return 0
    if not isinstance(records, list) or not records:
        return 0
    return max((r.get("id") or 0) for r in records)


def run(step: Step, dry: bool) -> None:
    print(f"$ {' '.join(step.cmd)}", flush=True)
    if dry:
        return
    rc = subprocess.run(step.cmd).returncode
    if rc != 0:
        if step.optional:
            print(f"  (optional step {step.name!r} exited {rc} — continuing)")
            return
        sys.exit(f"\nFAILED at {step.name!r} (exit {rc})")


# ---- main ------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--start",
        type=int,
        help="First id to scrape. Default = max(results.json id) + 1.",
    )
    parser.add_argument(
        "--end",
        type=int,
        default=None,
        help=(
            "Last id to scrape (inclusive). When omitted, the script probes "
            "chordtabs.in.th forward from (max id in results.json + 1) until "
            f"it sees {PROBE_MISS_THRESHOLD} consecutive misses."
        ),
    )
    parser.add_argument("--skip-scrape", action="store_true")
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument("--skip-sync-names", action="store_true")
    parser.add_argument("--skip-convert", action="store_true")
    parser.add_argument("--skip-upload", action="store_true")
    parser.add_argument("--skip-verify", action="store_true")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument(
        "--push",
        action="store_true",
        help="After the build, also `git add public/songs.bin && git commit && git push`.",
    )
    parser.add_argument(
        "--message",
        default=None,
        help="Commit message when --push is set. Default: 'data: refresh {start}..{end}'.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the commands for every step without running them.",
    )
    args = parser.parse_args()

    last = latest_scraped_id()
    start = args.start if args.start is not None else last + 1

    # Auto-detect `end` by probing the source unless the user pinned it,
    # the scrape step is being skipped, or we're in dry-run mode (the
    # probe makes real HTTP calls and we don't want surprises in dry-run).
    if args.end is not None:
        end = args.end
    elif args.skip_scrape or args.dry_run:
        end = last  # nothing to scrape; downstream still runs
    else:
        print_header("Probing source for new pages")
        end = probe_source_end(start)

    print_header(f"Chord sync — ids {start}..{end}")
    print(f"  Current max id in results.json: {last:,}")
    print(f"  Project root:                   {ROOT}")
    if args.dry_run:
        print("  DRY RUN — printing commands only.")

    if start > end:
        print(
            f"\nNothing new to scrape (start {start} > end {end}). "
            "Pipeline will still verify + rebuild downstream artifacts."
        )

    py = sys.executable  # same interpreter (works whether they invoked us as py / python / python.exe)

    steps: list[Step] = []
    if not args.skip_scrape and start <= end:
        steps.append(Step("Scrape new pages", [
            py, SCRIPTS / "scrape.py", "--start", start, "--end", end,
        ]))
    if not args.skip_download:
        steps.append(Step("Download PNGs", [py, SCRIPTS / "download.py"]))
        # download.py appends ids that served an HTML placeholder (not a real
        # image) to data/no_image_ids.json. Re-finalise so those drop out of
        # results.json BEFORE verify — otherwise they'd fail the
        # results.json ↔ images ↔ R2 cross-check one cycle later.
        steps.append(Step("Re-finalize (drop no-image ids found at download)", [
            py, SCRIPTS / "scrape.py", "--finalize",
        ]))
    if not args.skip_sync_names:
        # Apply alt ↔ filename rectification BEFORE conversion (sync_names
        # only knows about .png; running it after the convert step would
        # report every WebP file as "missing").
        steps.append(Step("Sync alt ↔ filename", [
            py, SCRIPTS / "sync_names.py",
        ]))
    if not args.skip_convert:
        steps.append(Step("Convert PNG → WebP (deletes source)", [
            py, SCRIPTS / "convert_to_webp.py",
        ]))
    if not args.skip_upload:
        steps.append(Step("Upload WebP → R2", [
            py, SCRIPTS / "upload_r2.py", IMAGES_DIR,
        ]))
    if not args.skip_verify:
        steps.append(Step("Verify sync (results.json ↔ images ↔ R2)", [
            py, SCRIPTS / "check_sync.py",
        ]))
    if not args.skip_build:
        # `npm run data` is just `node scripts/build-data.mjs` under the
        # hood; calling node directly avoids depending on npm-on-PATH and
        # keeps every step self-describing in the log.
        steps.append(Step("Rebuild public/songs.bin", [
            "node", SCRIPTS / "build-data.mjs",
        ]))
    if args.push:
        message = args.message or f"data: refresh {start}..{end}"
        # Wrap git in a tiny helper so we can short-circuit when there's
        # nothing to commit (the build step is a no-op if the data didn't
        # change, and we don't want to push empty commits).
        steps.append(Step(
            "Git commit + push public/songs.bin",
            [py, "-c", f"""
import subprocess, sys
subprocess.run(['git', 'add', 'public/songs.bin'], cwd=r'{ROOT}', check=True)
diff = subprocess.run(['git', 'diff', '--cached', '--quiet'], cwd=r'{ROOT}')
if diff.returncode == 0:
    print('  no songs.bin changes to commit')
    sys.exit(0)
subprocess.run(['git', 'commit', '-m', {message!r}], cwd=r'{ROOT}', check=True)
subprocess.run(['git', 'push'], cwd=r'{ROOT}', check=True)
print('  pushed: ' + {message!r})
""".strip()],
            optional=False,
        ))

    if not steps:
        print("\nAll steps skipped — nothing to do.")
        return

    started = time.time()
    for i, step in enumerate(steps, 1):
        print_step(i, len(steps), step.name)
        run(step, args.dry_run)

    elapsed = time.time() - started
    print_header(f"Pipeline complete — {elapsed/60:.1f} min")
    if args.push and not args.dry_run:
        print("Cloudflare Pages will redeploy in ~60s.")


if __name__ == "__main__":
    main()
