"""
Scrape the EXACT lyrics + chord palette for each song from its chordtabs.in.th
page — the deterministic ground truth the geometric chord-aligner needs.

Why this exists
---------------
The chord-sheet IMAGE has chords positioned over lyrics, but a vision model that
re-transcribes the whole sheet drops/garbles Thai text and misplaces chords. The
source page, however, already serves BOTH pieces we were missing:

  • the full LYRICS as text   (<h3>เนื้อเพลง …</h3> … block)  → no OCR needed
  • the exact CHORD PALETTE    (<img class="htmlchord" alt="chord-D">…)  → the
    closed set of chords used in the song, for validation.

So we scrape those once (free, deterministic) and let the aligner do the ONE
remaining job: place each chord over the right syllable (geometry) and read the
Intro/Instru/Outro rows (model). Lyrics + vocabulary become 100% correct by
construction.

Output  (data/song-src.jsonl, one JSON object per line, resumable):
  {"id": 1, "lyrics": "<full text, \\n line breaks, blank line between stanzas>",
   "palette": ["D","A","C#m","F#m","Bm","E"], "status": "ok"}
  {"id": 2, "lyrics": "", "palette": [...], "status": "no_lyrics"}

stdlib only (urllib + regex + threads) — no requests/bs4 dependency, mirroring
how scrape.py is structured but with zero pip deps so it runs in base python.

Run:
  python3 scripts/scrape_src.py                 # all ids in results.json (resumable)
  python3 scripts/scrape_src.py --ids 1,2,298   # just these ids (re-fetch)
  python3 scripts/scrape_src.py --limit 50      # smoke test the next 50 undone
  python3 scripts/scrape_src.py --start 70000   # only ids >= 70000
  python3 scripts/scrape_src.py --workers 16    # concurrency (default 24)
  python3 scripts/scrape_src.py --compact       # build data/song-src.json from jsonl
"""

import argparse
import html as htmlmod
import json
import os
import re
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
DATA = os.path.join(ROOT, "data")
RESULTS = os.path.join(DATA, "results.json")
OUT_JSONL = os.path.join(DATA, "song-src.jsonl")
OUT_JSON = os.path.join(DATA, "song-src.json")

BASE_URL = "https://chordtabs.in.th/{id}/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
TIMEOUT = 20
RETRIES = 2

_write_lock = threading.Lock()


# ── extraction (the proven recipe — handles every HTML variant we've seen) ────
def norm_chord(a: str) -> str:
    """alt='chord-C-sharp-m' → 'C#m'; 'chord-B-flat' → 'Bb'."""
    return (a.replace("-sharp-", "#").replace("-flat-", "b")
             .replace("-sharp", "#").replace("-flat", "b"))


def extract_palette(html: str) -> list[str]:
    out: list[str] = []
    for a in re.findall(r'alt="chord-([^"]+)"', html):
        c = norm_chord(a)
        if c and c not in out:
            out.append(c)
    return out


def extract_lyrics(html: str) -> str | None:
    """Everything from <h3>เนื้อเพลง…</h3> up to the related-songs container,
    de-tagged. Returns None when the page has no lyrics block at all.

    The lyrics live in heterogeneous markup across the catalogue: a <p>, a
    <p style>, one <div><span> per line, or bare text + <br> right after the
    <h3>. Slicing the region and converting structural tags to newlines covers
    all of them without per-page special-casing.
    """
    m = re.search(r"<h3>\s*เนื้อเพลง[^<]*</h3>", html)
    if not m:
        return None
    start = m.end()
    end = len(html)
    for marker in ('<div class="container">', '<div class="divcenter">',
                   '<div class="scrollmenu'):
        i = html.find(marker, start)
        if i != -1:
            end = min(end, i)
    seg = html[start:end]
    seg = re.sub(r"<br\s*/?>", "\n", seg, flags=re.I)
    seg = re.sub(r"</(div|p|h3)>", "\n", seg, flags=re.I)
    seg = re.sub(r"<[^>]+>", "", seg)             # drop remaining tags
    seg = htmlmod.unescape(seg).replace("\xa0", " ")
    # Some songs have only the chord IMAGE, no text lyrics — the page prints a
    # "ไม่มีเนื้อเพลง" (no lyrics) placeholder. Treat that as no_lyrics so the
    # aligner falls back instead of trying to place chords onto the placeholder.
    if "ไม่มีเนื้อเพลง" in seg:
        return None
    # normalise: rstrip each line, collapse runs of blank lines to ONE (stanza
    # break), drop leading/trailing blanks.
    out: list[str] = []
    blank = 0
    for ln in seg.split("\n"):
        ln = ln.rstrip()
        if not ln.strip():
            blank += 1
            if blank <= 1:
                out.append("")
        else:
            blank = 0
            out.append(ln.strip())
    while out and not out[0]:
        out.pop(0)
    while out and not out[-1]:
        out.pop()
    return "\n".join(out)


def fetch(page_id: int) -> dict:
    url = BASE_URL.format(id=page_id)
    last = None
    for attempt in range(RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                raw = r.read()
            html = raw.decode("utf-8", "replace")
            palette = extract_palette(html)
            lyrics = extract_lyrics(html)
            if lyrics is None:
                return {"id": page_id, "lyrics": "", "palette": palette,
                        "status": "no_lyrics"}
            return {"id": page_id, "lyrics": lyrics, "palette": palette,
                    "status": "ok"}
        except Exception as e:  # noqa: BLE001 — best-effort scraper, retry then skip
            last = e
            time.sleep(0.5 * (attempt + 1))
    return {"id": page_id, "error": str(last), "status": "fetch_error"}


def load_done() -> set[int]:
    done: set[int] = set()
    if not os.path.exists(OUT_JSONL):
        return done
    with open(OUT_JSONL, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                # only count successfully-scraped rows as done; retry errors
                if obj.get("status") in ("ok", "no_lyrics"):
                    done.add(int(obj["id"]))
            except (json.JSONDecodeError, KeyError, ValueError):
                pass
    return done


def append(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False)
    with _write_lock:
        with open(OUT_JSONL, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def compact() -> None:
    """Fold the resumable jsonl into a single id→record dict (last write wins)."""
    if not os.path.exists(OUT_JSONL):
        print("no song-src.jsonl yet")
        return
    by_id: dict[str, dict] = {}
    with open(OUT_JSONL, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                by_id[str(obj["id"])] = obj
            except (json.JSONDecodeError, KeyError):
                continue
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(by_id, f, ensure_ascii=False)
    ok = sum(1 for v in by_id.values() if v.get("status") == "ok")
    print(f"compacted {len(by_id):,} rows ({ok:,} with lyrics) → {OUT_JSON}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--compact", action="store_true")
    args = ap.parse_args()

    if args.compact:
        compact()
        return

    if not os.path.exists(RESULTS):
        sys.exit(f"ERROR: {RESULTS} not found")
    records = json.load(open(RESULTS, encoding="utf-8"))
    all_ids = [int(r["id"]) for r in records]

    if args.ids:
        want = {int(x) for x in args.ids.split(",") if x.strip()}
        todo = [i for i in all_ids if i in want]            # re-fetch even if done
    else:
        done = load_done()
        todo = [i for i in all_ids if i >= args.start and i not in done]
    if args.limit:
        todo = todo[: args.limit]

    if not todo:
        print("nothing to do — every targeted song already scraped.")
        return
    print(f"scrape_src: {len(todo):,} pages @ {args.workers} workers")

    ok = nolyr = err = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(fetch, i): i for i in todo}
        for n, fut in enumerate(as_completed(futs), 1):
            obj = fut.result()
            append(obj)
            st = obj.get("status")
            if st == "ok":
                ok += 1
            elif st == "no_lyrics":
                nolyr += 1
            else:
                err += 1
            if n % 200 == 0 or n == len(todo):
                el = time.time() - t0
                rate = n / el if el else 0
                eta = (len(todo) - n) / rate if rate else 0
                print(f"  [{n:,}/{len(todo):,}] ok={ok:,} no_lyrics={nolyr:,} "
                      f"err={err:,}  {rate:.0f}/s  eta {eta/60:.1f}m", flush=True)

    print(f"done — ok={ok:,} no_lyrics={nolyr:,} err={err:,}")
    print(f"next: python3 scripts/scrape_src.py --compact  (build {os.path.basename(OUT_JSON)})")


if __name__ == "__main__":
    main()
