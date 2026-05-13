import json, os, re
from collections import Counter
from urllib.parse import urlparse

INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
OUT_DIR = r"C:\Users\black\OneDrive\เดสก์ท็อป\chordtabs"

def clean_alt(alt):
    s = alt
    if s.startswith("คอร์ด "):
        s = s[len("คอร์ด "):]
    s = INVALID.sub("_", s)
    s = re.sub(r"\s+", " ", s).strip().rstrip(". ")
    return s or "untitled"

d = json.load(open(r"C:\Users\black\chordtabs_scrape\results.json", "r", encoding="utf-8"))
cleaned = [clean_alt(r["alt"]) for r in d]
counts = Counter(name.lower() for name in cleaned)

expected = set()
for r, name in zip(d, cleaned):
    ext = os.path.splitext(urlparse(r["src"]).path)[1].lower() or ".png"
    fname = f"{name}_{r['id']}{ext}" if counts[name.lower()] > 1 else f"{name}{ext}"
    expected.add(fname.lower())  # case-insensitive

on_disk = {f.lower() for f in os.listdir(OUT_DIR)}

extra = on_disk - expected
missing = expected - on_disk

print(f"Expected files: {len(expected):,}")
print(f"On disk:        {len(on_disk):,}")
print(f"Extra on disk (not in records): {len(extra)}")
print(f"Missing from disk:              {len(missing)}")
print()
if extra:
    print("Extra files:")
    for f in sorted(extra):
        print(f"  {f}")
if missing:
    print("Missing files:")
    for f in sorted(missing)[:20]:
        print(f"  {f}")
