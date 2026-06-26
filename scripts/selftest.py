"""
Self-test / visual QA for the chord aligner. Renders each produced ChordPro
(data/songs-md/<id>.md) back into a chord-sheet image (Tahoma, chord-over-lyric)
and stacks it next to the ORIGINAL source image so you can eyeball whether chords
land on the right syllables and whether intro/instru/outro rows are present.

Also prints an APPROXIMATE visual-match % (ink-overlap after scaling) — useful as
a relative quality signal across songs, NOT an absolute correctness guarantee
(our render and the source use slightly different spacing).

  scripts/.venv/bin/python scripts/selftest.py --ids 1,2     # compare these
  scripts/.venv/bin/python scripts/selftest.py --ids 1 --open  # + macOS preview
Outputs side-by-side PNGs to data/songs-md/compare/<id>.png
"""
import argparse, io, os, re, urllib.request, urllib.parse
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "data", "songs-md")
CMP_DIR = os.path.join(OUT_DIR, "compare")
RESULTS = os.path.join(ROOT, "data", "results.json")
FONT = "/System/Library/Fonts/Supplemental/Tahoma.ttf"

def _env():
    f = os.path.join(ROOT, ".env.local")
    if os.path.exists(f):
        for ln in open(f, encoding="utf-8"):
            ln = ln.strip()
            if ln and not ln.startswith("#") and "=" in ln:
                k, v = ln.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
_env()
IMAGE_BASE = os.environ.get("VITE_IMAGE_BASE", "").rstrip("/")

INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
def clean_name(alt):
    s = alt[len("คอร์ด "):] if alt.startswith("คอร์ด ") else alt
    return (re.sub(r"\s+", " ", INVALID.sub("_", s)).strip().rstrip(". ")) or "untitled"

def name_map():
    import json
    recs = json.load(open(RESULTS, encoding="utf-8"))
    counts = {}
    for r in recs:
        counts[clean_name(r["alt"]).lower()] = counts.get(clean_name(r["alt"]).lower(), 0) + 1
    out = {}
    for r in recs:
        b = clean_name(r["alt"])
        out[int(r["id"])] = f"{b}_{r['id']}" if counts[b.lower()] > 1 else b
    return out

def source_image(name):
    local = os.path.join(ROOT, "images", f"{name}.webp")
    if os.path.exists(local):
        return Image.open(local).convert("RGB")
    if not IMAGE_BASE:
        return None
    url = f"{IMAGE_BASE}/{urllib.parse.quote(name)}.webp"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        return Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=30).read())).convert("RGB")
    except Exception:
        return None

# ── parse + render ChordPro ──────────────────────────────────────────────────
LABEL_RE = re.compile(r"\b(intro|verse|chorus|prechorus|bridge|outro|ending|coda|"
                      r"solo|interlude|instru(?:mental)?|hook|tag|riff)\b", re.I)
def is_chord_only(line):
    rest = re.sub(r"\[[^\]]*\]", " ", line)
    rest = re.sub(r"\([^)]*\)", " ", rest)
    rest = LABEL_RE.sub(" ", rest)
    rest = re.sub(r"[/|×x*:.,\-–—\d]", " ", rest, flags=re.I)
    return rest.strip() == ""

def parse_segments(line):
    segs, last, cur = [], 0, None
    for m in re.finditer(r"\[([^\]]*)\]", line):
        if m.start() > last:
            txt = line[last:m.start()]
            if cur is None:
                segs.append(("", txt))
            else:
                segs[-1] = (segs[-1][0], segs[-1][1] + txt)
        segs.append((m.group(1), ""))
        cur = True
        last = m.end()
    if last < len(line):
        if segs:
            segs[-1] = (segs[-1][0], segs[-1][1] + line[last:])
        else:
            segs.append(("", line[last:]))
    return segs

def render_md(md, W=600, fs=22):
    lyf = ImageFont.truetype(FONT, fs)
    chf = ImageFont.truetype(FONT, int(fs * 0.82))
    band = int(fs * 1.5)         # chord band height above a lyric line
    rows = []
    for raw in md.split("\n"):
        line = raw.rstrip("\n")
        d = re.match(r"^\{\s*([a-z_]+)\s*:\s*([^}]*)\}\s*$", line, re.I)
        if d:
            rows.append(("note", f"{d.group(1)}: {d.group(2).strip()}")); continue
        if line.strip() == "":
            rows.append(("blank",)); continue
        if is_chord_only(line):
            rows.append(("chordrow", re.sub(r"\[([^\]]*)\]", r"\1", line))); continue
        rows.append(("lyric", parse_segments(line)))
    # measure height
    H = 8
    for r in rows:
        if r[0] == "blank": H += int(fs * 0.5)
        elif r[0] == "note": H += int(fs * 1.2)
        elif r[0] == "chordrow": H += int(fs * 1.2)
        else: H += band + int(fs * 1.25)
    im = Image.new("RGB", (W, H + 8), "white"); dr = ImageDraw.Draw(im)
    y = 8
    for r in rows:
        if r[0] == "blank":
            y += int(fs * 0.5)
        elif r[0] == "note":
            dr.text((4, y), r[1], font=chf, fill=(150, 80, 0)); y += int(fs * 1.2)
        elif r[0] == "chordrow":
            dr.text((4, y), r[1], font=chf, fill=(0, 0, 0)); y += int(fs * 1.2)
        else:
            x = 4
            for chord, txt in r[1]:
                if chord:
                    dr.text((x, y), chord, font=chf, fill=(180, 30, 30))
                dr.text((x, y + band), txt, font=lyf, fill=(0, 0, 0))
                x += int(lyf.getlength(txt))
            y += band + int(fs * 1.25)
    return im

def visual_match(src, mine):
    """rough ink-overlap % after scaling mine to src dims."""
    w = 600
    def prep(im):
        im = im.convert("L")
        im = im.resize((w, int(im.height * w / im.width)))
        return np.asarray(im) < 150
    a = prep(src)
    b = prep(mine)
    h = min(a.shape[0], b.shape[0])
    a, b = a[:h], b[:h]
    inter = (a & b).sum(); union = (a | b).sum()
    return round(100 * inter / union, 1) if union else 0.0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", required=True)
    ap.add_argument("--open", action="store_true")
    args = ap.parse_args()
    os.makedirs(CMP_DIR, exist_ok=True)
    names = name_map()
    for i in [int(x) for x in args.ids.split(",") if x.strip()]:
        mdp = os.path.join(OUT_DIR, f"{i}.md")
        if not os.path.exists(mdp):
            print(f"#{i}: no .md"); continue
        md = open(mdp, encoding="utf-8").read()
        src = source_image(names.get(i, ""))
        if src is None:
            print(f"#{i}: no source image"); continue
        # scale source to width 600
        sw = 600
        src_s = src.resize((sw, int(src.height * sw / src.width)))
        mine = render_md(md, W=sw, fs=22)
        pct = visual_match(src, mine)
        H = max(src_s.height, mine.height)
        canvas = Image.new("RGB", (sw * 2 + 12, H + 24), (235, 235, 235))
        d = ImageDraw.Draw(canvas)
        d.text((6, 4), f"SOURCE  #{i}", fill=(0, 0, 0))
        d.text((sw + 18, 4), f"MINE  (visual~{pct}%)", fill=(0, 0, 0))
        canvas.paste(src_s, (6, 20)); canvas.paste(mine, (sw + 12, 20))
        outp = os.path.join(CMP_DIR, f"{i}.png")
        canvas.save(outp)
        print(f"#{i}: visual~{pct}%  -> {outp}")
        if args.open:
            os.system(f"open '{outp}'")

if __name__ == "__main__":
    main()
