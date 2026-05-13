"""Scan results.json + songs.json for any non-ASCII control / unusual
whitespace chars in song titles that JS `\\s+` won't catch but Python /
filesystem may normalize to space."""

import json
import pathlib
import unicodedata

ROOT = pathlib.Path(r"F:\chord")
SRC = ROOT / "data" / "results.json"
SONGS = ROOT / "public" / "songs.json"


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


for path, field in [(SRC, "alt"), (SONGS, "file")]:
    print(f"\n== {path}  field={field} ==")
    hits = scan(path, field)
    print(f"hits: {len(hits)}")
    for id_, s, problems in hits[:50]:
        codes = " ".join(f"U+{cp:04X}({cat})" for _, cp, cat in problems)
        print(f"  id={id_}  [{codes}]  {s!r}")
