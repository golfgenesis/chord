"""
One-shot diagnostic: find which results.json records correspond to the
8 PNG files that turned out to be HTML error pages (cwebp rejected them
during the 70k WebP conversion).

Run:
  py F:\chord\scripts\find_broken.py
"""

import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "data" / "results.json"

# The 8 filenames that failed cwebp (start with "<!DOCT" instead of "\x89PNG").
BROKEN = [
    "Emotions Brenda Lee",
    "Only_The_Strong_Survive Elvis Presley",
    "Strong Robbies Williams",
    "ขอ ( อีกครั้ง ) Anything Else",
    "ตะวันเลียตูด The Richman Toy",
    "ปล่อยให้เลยผ่าน Anything Else",
    "ปาณาฯ คาราบาว",
    "เพื่อเธอตลอดไป ศักดา พัทธสีมา_23253",
]

INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
PREFIX = "คอร์ด "


def clean(alt: str) -> str:
    s = alt[len(PREFIX):] if alt.startswith(PREFIX) else alt
    s = INVALID.sub("_", s)
    s = re.sub(r"\s+", " ", s).strip().rstrip(". ")
    return s or "untitled"


records = json.loads(RESULTS.read_text(encoding="utf-8"))
cleaned = [clean(r["alt"]) for r in records]
counts = Counter(name.lower() for name in cleaned)

# Reverse-map: clean(alt) → record (or clean(alt) + "_id" if duplicate)
by_name = {}
for r, name in zip(records, cleaned):
    is_dup = counts[name.lower()] > 1
    key = f"{name}_{r['id']}" if is_dup else name
    by_name[key] = r

print(f"Looking up {len(BROKEN)} broken filenames against {len(records):,} records:\n")
for name in BROKEN:
    r = by_name.get(name)
    if r:
        print(f"  id={r['id']:>6}  alt={r['alt']!r}")
        print(f"           src={r['src']}")
    else:
        print(f"  [NOT FOUND IN RESULTS] {name}")
