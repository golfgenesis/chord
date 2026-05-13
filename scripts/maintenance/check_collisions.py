import json, re, os
from collections import defaultdict, Counter
from urllib.parse import urlparse

INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

def clean_alt(alt):
    s = alt
    if s.startswith("คอร์ด "):
        s = s[len("คอร์ด "):]
    s = INVALID.sub("_", s)
    s = re.sub(r"\s+", " ", s).strip().rstrip(". ")
    return s or "untitled"

d = json.load(open(r"C:\Users\black\chordtabs_scrape\results.json", "r", encoding="utf-8"))
cleaned = [clean_alt(r["alt"]) for r in d]
counts = Counter(cleaned)
targets = []
for r, name in zip(d, cleaned):
    ext = os.path.splitext(urlparse(r["src"]).path)[1].lower() or ".png"
    fname = f"{name}_{r['id']}{ext}" if counts[name] > 1 else f"{name}{ext}"
    targets.append((r["id"], r["alt"], fname))

ci_groups = defaultdict(list)
for rid, alt, fname in targets:
    ci_groups[fname.lower()].append((rid, alt, fname))

collisions = [(k, v) for k, v in ci_groups.items() if len(v) > 1]
affected = sum(len(v) for _, v in collisions)

print(f"Total records:                       {len(d):,}")
print(f"Unique filenames (case-sensitive):   {len(set(t[2] for t in targets)):,}")
print(f"Unique filenames (case-insensitive): {len(ci_groups):,}")
print(f"Files on disk would be:              {len(ci_groups):,}")
print(f"Case-insensitive collision groups:   {len(collisions)}")
print(f"Records lost to overwrite:           {affected - len(collisions)}")
print()
print("Sample collision groups (first 8):")
for k, v in collisions[:8]:
    print(f"  {len(v)}x  →  {v[0][2]}")
    for rid, alt, fname in v:
        print(f"      id={rid:>6}  alt={alt!r}")
        print(f"               fname={fname}")

# Save full list for user review
out = []
for k, v in collisions:
    out.append({
        "filename_lower": k,
        "count": len(v),
        "records": [{"id": rid, "alt": alt, "fname": fname} for rid, alt, fname in v],
    })
json.dump(out, open(r"C:\Users\black\chordtabs_scrape\case_collisions.json", "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)
print(f"\nFull list saved to case_collisions.json")
