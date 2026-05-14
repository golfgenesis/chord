"""
One-shot: re-scrape the 8 broken IDs by hitting their chord page directly
(not the image URL). Sometimes the page still exists with a different
image src than results.json captured, or the page is gone entirely.

For each id:
  1. GET https://chordtabs.in.th/{id}/  → check status + parse <img>
  2. If <img> found, HEAD the src to verify it's a real image (not HTML)
  3. Print report; if it's a real image, download it to images/

Run:
  $env:PYTHONIOENCODING="utf-8"
  py F:\\chord\\scripts\\rescrape_broken.py
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

# These 8 song ids had download.py save an HTML error page as their PNG —
# the bytes start with "<!DOCT". They're either deleted from the source
# site or moved to a different URL since the original scrape.
BROKEN_IDS = [2390, 3936, 6215, 6377, 10657, 16990, 23253, 26294]

PROJECT_ROOT = Path(__file__).resolve().parent.parent
IMAGES_DIR = PROJECT_ROOT / "images"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36"
)


def main() -> None:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "th,en;q=0.8",
        }
    )

    recovered: list[tuple[int, str, str]] = []  # (id, alt, src)
    gone: list[int] = []

    for page_id in BROKEN_IDS:
        page_url = f"https://chordtabs.in.th/{page_id}/"
        print(f"\nid={page_id}  GET {page_url}")
        try:
            r = session.get(page_url, timeout=20, allow_redirects=True)
        except requests.RequestException as e:
            print(f"  ERROR: {type(e).__name__}: {e}")
            gone.append(page_id)
            continue
        print(f"  -> HTTP {r.status_code}  final={r.url}")
        if r.status_code != 200:
            gone.append(page_id)
            continue

        soup = BeautifulSoup(r.text, "lxml")
        div = soup.find(id="divlyric")
        if not div:
            print("  no #divlyric on page — chord sheet missing")
            gone.append(page_id)
            continue
        img = div.find("img")
        if not img:
            print("  no <img> in #divlyric — chord sheet missing")
            gone.append(page_id)
            continue
        src = img.get("src")
        alt = img.get("alt")
        if not src:
            print("  <img> has no src")
            gone.append(page_id)
            continue
        # Page sometimes returns a relative src like `/img/nm/N.png`;
        # resolve it against the final URL before HEAD/GET.
        src = urljoin(r.url, src)

        # Verify the src actually serves an image (not another redirect to HTML).
        try:
            h = session.head(src, timeout=10, allow_redirects=True)
        except requests.RequestException as e:
            print(f"  HEAD {src} ERROR: {e}")
            gone.append(page_id)
            continue
        ct = h.headers.get("Content-Type", "")
        print(f"  img src={src}")
        print(f"  img Content-Type={ct}  HTTP {h.status_code}")
        if h.status_code == 200 and ct.startswith("image/"):
            print(f"  ✓ RECOVERABLE: alt={alt!r}")
            recovered.append((page_id, alt or "", src))
        else:
            print("  ✗ src is not an image (probably another redirect to HTML)")
            gone.append(page_id)

    print("\n" + "=" * 70)
    print(f"Recoverable: {len(recovered)} / {len(BROKEN_IDS)}")
    print(f"Gone:        {len(gone)} / {len(BROKEN_IDS)}")

    if not recovered:
        print("\nNo songs to re-download. The 8 records are dead.")
        return

    # Download the recovered images, overwriting the bogus HTML payload.
    print("\nDownloading recovered images...")
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    for page_id, alt, src in recovered:
        # We can't easily reconstruct the exact original filename without
        # re-running build_targets logic; just save to id-prefixed name.
        # Caller can run convert_to_webp.py + sync_names.py afterwards.
        out = IMAGES_DIR / f"_recovered_{page_id}.png"
        try:
            r = session.get(src, timeout=30)
            r.raise_for_status()
            out.write_bytes(r.content)
            size_kb = len(r.content) / 1024
            print(f"  id={page_id}  -> {out.name}  ({size_kb:.1f} KB)")
        except Exception as e:
            print(f"  id={page_id}  download FAILED: {e}")

    print(
        "\nNext steps if any were recovered:\n"
        "  1. Inspect _recovered_*.png files in F:/chord/images/\n"
        "  2. If valid: rename to match the song's expected filename,\n"
        "     run convert_to_webp.py, run upload_r2.py, rebuild songs.bin.\n"
        "  3. If none were recovered, run the cleanup path:\n"
        "     remove the dead ids from data/results.json + rebuild songs.bin."
    )


if __name__ == "__main__":
    main()
