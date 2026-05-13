"""
Scrape chordtabs.in.th/{id}/ for id 1..70569.
- Reads <div id="divlyric"><img src=".." alt=".."></div>
- Writes one JSON object per line to results.jsonl (resumable)
- Skips ids already in results.jsonl
- Concurrent fetching with a thread pool
- At the end, compact results.jsonl -> results.json (array, sorted by id)

Run:  python scrape.py
Stop:  Ctrl+C (safe; partial results saved in results.jsonl)
Resume: just run again — it will skip ids already done.
Finalize JSON only: python scrape.py --finalize
"""

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://chordtabs.in.th/{id}/"
START_ID = 1
END_ID = 70569          # inclusive
WORKERS = 32            # concurrent requests
REQUEST_TIMEOUT = 20    # seconds
RETRIES = 2             # per id (in addition to the first attempt)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
LOGS_DIR = os.path.join(PROJECT_ROOT, "logs")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(LOGS_DIR, exist_ok=True)
JSONL_PATH = os.path.join(DATA_DIR, "results.jsonl")
FINAL_JSON_PATH = os.path.join(DATA_DIR, "results.json")
ERRORS_PATH = os.path.join(LOGS_DIR, "scrape_errors.log")

write_lock = threading.Lock()
err_lock = threading.Lock()


def load_done_ids():
    done = set()
    if not os.path.exists(JSONL_PATH):
        return done
    with open(JSONL_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if "id" in obj:
                    done.add(int(obj["id"]))
            except json.JSONDecodeError:
                pass
    return done


def log_error(msg):
    with err_lock:
        with open(ERRORS_PATH, "a", encoding="utf-8") as f:
            f.write(msg + "\n")


def append_result(obj):
    line = json.dumps(obj, ensure_ascii=False)
    with write_lock:
        with open(JSONL_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def fetch_one(session: requests.Session, page_id: int):
    url = BASE_URL.format(id=page_id)
    last_err = None
    for attempt in range(RETRIES + 1):
        try:
            r = session.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
            # Treat 404 as "no entry" — record id with null fields
            if r.status_code == 404:
                return {"id": page_id, "src": None, "alt": None, "status": 404}
            r.raise_for_status()
            soup = BeautifulSoup(r.text, "lxml")
            div = soup.find(id="divlyric")
            if div is None:
                return {"id": page_id, "src": None, "alt": None, "status": "no_div"}
            img = div.find("img")
            if img is None:
                return {"id": page_id, "src": None, "alt": None, "status": "no_img"}
            return {
                "id": page_id,
                "src": img.get("src"),
                "alt": img.get("alt"),
            }
        except requests.RequestException as e:
            last_err = e
            time.sleep(0.5 * (attempt + 1))
    log_error(f"id={page_id} failed after retries: {last_err}")
    return None  # signal failure; caller will not write a line so it can retry next run


def make_session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "th,en;q=0.8",
    })
    return s


def run_scrape():
    done = load_done_ids()
    todo = [i for i in range(START_ID, END_ID + 1) if i not in done]
    total = END_ID - START_ID + 1
    print(f"Already done: {len(done):,}  /  Total: {total:,}  /  Remaining: {len(todo):,}")
    if not todo:
        print("Nothing to do. Finalizing JSON.")
        finalize_json()
        return

    session = make_session()
    completed = 0
    failed = 0
    started = time.time()

    try:
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futures = {ex.submit(fetch_one, session, i): i for i in todo}
            for fut in as_completed(futures):
                page_id = futures[fut]
                try:
                    result = fut.result()
                except Exception as e:
                    log_error(f"id={page_id} raised: {e}")
                    failed += 1
                    continue
                if result is None:
                    failed += 1
                else:
                    append_result(result)
                completed += 1
                if completed % 200 == 0 or completed == len(todo):
                    elapsed = time.time() - started
                    rate = completed / elapsed if elapsed else 0
                    eta = (len(todo) - completed) / rate if rate else 0
                    print(
                        f"[{completed:,}/{len(todo):,}] "
                        f"rate={rate:.1f}/s  "
                        f"eta={eta/60:.1f} min  "
                        f"failed={failed}",
                        flush=True,
                    )
    except KeyboardInterrupt:
        print("\nInterrupted by user. Partial results saved. Re-run to resume.")
        return

    print(f"Done. Completed this run: {completed:,}  Failed (will retry next run): {failed:,}")
    finalize_json()


def finalize_json():
    if not os.path.exists(JSONL_PATH):
        print("No results.jsonl to finalize.")
        return
    print("Building results.json ...")
    by_id = {}
    with open(JSONL_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                by_id[int(obj["id"])] = obj
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
    # Keep only successful (src not null) in the final array; tweak if you want all rows.
    items = [by_id[k] for k in sorted(by_id) if by_id[k].get("src")]
    with open(FINAL_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    print(f"Wrote {len(items):,} records to {FINAL_JSON_PATH}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--finalize", action="store_true", help="Only build results.json from results.jsonl")
    p.add_argument("--start", type=int, default=None)
    p.add_argument("--end", type=int, default=None)
    p.add_argument("--workers", type=int, default=None)
    args = p.parse_args()

    global START_ID, END_ID, WORKERS
    if args.start is not None:
        START_ID = args.start
    if args.end is not None:
        END_ID = args.end
    if args.workers is not None:
        WORKERS = args.workers

    if args.finalize:
        finalize_json()
        return
    run_scrape()


if __name__ == "__main__":
    main()
