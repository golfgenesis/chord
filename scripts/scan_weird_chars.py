r"""
Scan data/results.json for non-ASCII control / unusual whitespace chars
in song titles that JS `\s+` won't catch but Python and the filesystem
may normalize to space (or otherwise treat oddly).

Used after a fresh scrape to spot titles that need cleaning before they
end up in results.json — bad chars there propagate into filenames on
disk and into songs.bin via build-data.mjs.

Run:
  py F:\chord\scripts\scan_weird_chars.py
"""

import json
import pathlib
import unicodedata

ROOT = pathlib.Path(r"F:\chord")
SRC = ROOT / "data" / "results.json"


def weird_chars(s: str):
    """Yield (char, codepoint, category) for chars that aren't ASCII space
    but are control / format / line-separator / space-separator other than
    U+0020."""
    for ch in s:
        cp = ord(ch)
        if ch == " ":  # plain space
            continue
        cat = unicodedata.category(ch)
        # Cc = control, Cf = format, Zl = line sep, Zp = para sep,
        # Zs = space separator (other than U+0020)
        if cat in ("Cc", "Cf", "Zl", "Zp") or (cat == "Zs" and cp != 0x20):
            yield ch, cp, cat


def scan(path: pathlib.Path, field: str):
    data = json.loads(path.read_text(encoding="utf-8"))
    hits = []
    for r in data:
        s = r.get(field, "") or ""
        problems = list(weird_chars(s))
        if problems:
            hits.append((r.get("id"), s, problems))
    return hits


print(f"== {SRC}  field=alt ==")
hits = scan(SRC, "alt")
print(f"hits: {len(hits)}")
for id_, s, problems in hits[:50]:
    codes = " ".join(f"U+{cp:04X}({cat})" for _, cp, cat in problems)
    print(f"  id={id_}  [{codes}]  {s!r}")
