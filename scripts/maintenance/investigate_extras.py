import json, re
INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

def clean_alt(alt):
    s = alt
    if s.startswith("คอร์ด "):
        s = s[len("คอร์ด "):]
    s = INVALID.sub("_", s)
    s = re.sub(r"\s+", " ", s).strip().rstrip(". ")
    return s or "untitled"

d = json.load(open(r"C:\Users\black\chordtabs_scrape\results.json", "r", encoding="utf-8"))

targets = ["drivers license olivia rodrigo", "tell it to my heart meduza"]
for t in targets:
    print(f"=== Records cleaning to {t!r} (case-insensitive): ===")
    for r in d:
        c = clean_alt(r["alt"])
        if c.lower() == t:
            print(f"  id={r['id']:>6}  alt={r['alt']!r}  cleaned={c!r}")
    print()
