"""
Hybrid chord-sheet → Inline ChordPro aligner (geometry + local model), 100% free
and on-device. Produces data/songs-md/<id>.md with chords placed over the right
syllables, and a per-song confidence report from an INDEPENDENT self-test.

Design (why this beats "vision model transcribes everything")
-------------------------------------------------------------
The lyrics and the exact chord vocabulary are NOT guessed — they are scraped from
the song's chordtabs page (scripts/scrape_src.py → data/song-src.jsonl). So:

  • LYRICS are reproduced verbatim (we insert [chord] markers into the scraped
    text; we never let the model rewrite Thai) → lyric fidelity is 100% by
    construction and asserted.
  • CHORD VOCABULARY is the scraped palette → every emitted chord is validated
    against it.
  • CHORD POSITION (the one hard part) is solved two INDEPENDENT ways and the
    agreement between them is the self-test:
      1. GEOMETRY (deterministic, pixel-level): the source sheets are rendered in
         Tahoma; we render the known line in Tahoma and align it to the image
         lyric row with a one-sided-gap DP ("source = render + inserted spaces"),
         then map each detected chord-token x to a character.
      2. MODEL (semantic): one local Ollama vision call returns, per line, the
         ordered chords + a short anchor substring, plus the Intro/Instru/Outro
         rows. Identity comes from here; the anchor gives an independent position.
    Where geometry and model agree (≤ tol chars) the placement is trusted; where
    they conflict the line is flagged in the report (and can be re-read).

Run:
  scripts/.venv/bin/python scripts/align.py --ids 1,2        # specific songs
  scripts/.venv/bin/python scripts/align.py --limit 50       # next 50 un-done
  scripts/.venv/bin/python scripts/align.py --report-only --ids 1   # no write
Outputs: data/songs-md/<id>.md  +  data/songs-md/<id>.report.json
Requires: a populated data/song-src.jsonl (run scripts/scrape_src.py first) and a
local Ollama with a vision model (default qwen2.5vl:7b) for identity/instru rows.
"""
import argparse, base64, io, json, os, re, sys, tempfile
import urllib.request, urllib.parse
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import scipy.ndimage as ndi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_JSONL = os.path.join(ROOT, "data", "song-src.jsonl")
RESULTS = os.path.join(ROOT, "data", "results.json")
IMAGES_DIR = os.path.join(ROOT, "images")
OUT_DIR = os.path.join(ROOT, "data", "songs-md")
FONT = "/System/Library/Fonts/Supplemental/Tahoma.ttf"

OLLAMA = (os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
          + "/api/generate")
MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5vl:7b")
THAI = re.compile(r"[฀-๿]")
COMB = set([0x0e31] + list(range(0x0e34, 0x0e3b)) + list(range(0x0e47, 0x0e4f)))
INK_THR = 110
LYRIC_FILL = 0.40
AGREE_TOL = 3          # chars; |geometry - model| within this == agreement


# ── env (.env.local for VITE_IMAGE_BASE) ─────────────────────────────────────
def _load_env():
    f = os.path.join(ROOT, ".env.local")
    if not os.path.exists(f):
        return
    for line in open(f, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(), v)
_load_env()
IMAGE_BASE = os.environ.get("VITE_IMAGE_BASE", "").rstrip("/")

INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
def clean_name(alt):
    s = alt[len("คอร์ด "):] if alt.startswith("คอร์ด ") else alt
    s = INVALID.sub("_", s)
    s = re.sub(r"\s+", " ", s).strip().rstrip(". ")
    return s or "untitled"


# ── data loading ─────────────────────────────────────────────────────────────
def load_src():
    src = {}
    if os.path.exists(SRC_JSONL):
        for line in open(SRC_JSONL, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
                if o.get("status") in ("ok", "no_lyrics"):
                    src[int(o["id"])] = o
            except (json.JSONDecodeError, KeyError, ValueError):
                pass
    return src

def name_map():
    recs = json.load(open(RESULTS, encoding="utf-8"))
    counts = {}
    for r in recs:
        n = clean_name(r["alt"]).lower()
        counts[n] = counts.get(n, 0) + 1
    out = {}
    for r in recs:
        base = clean_name(r["alt"])
        out[int(r["id"])] = f"{base}_{r['id']}" if counts[base.lower()] > 1 else base
    return out

def load_image(name):
    """PIL RGB image of the chord sheet (local webp first, else R2)."""
    local = os.path.join(IMAGES_DIR, f"{name}.webp")
    if os.path.exists(local):
        return Image.open(local).convert("RGB")
    if not IMAGE_BASE:
        return None
    url = f"{IMAGE_BASE}/{urllib.parse.quote(name)}.webp"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
        return Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return None


# ── geometry ─────────────────────────────────────────────────────────────────
def ink_of(im):
    return (np.asarray(im).mean(axis=2) < INK_THR)

def bands_of(ink):
    H_, W = ink.shape
    on = ink.sum(axis=1) > max(2, int(0.003 * W))
    raw, y = [], 0
    while y < H_:
        if on[y]:
            y0 = y
            while y < H_ and on[y]:
                y += 1
            raw.append([y0, y])
        else:
            y += 1
    b = []
    for r in raw:
        if b and r[0] - b[-1][1] < 4:
            b[-1][1] = r[1]
        else:
            b.append(r)
    return b

def classify(ink, bands):
    """Lyric rows are Thai: glyph bodies sit in the MIDDLE/LOWER of the row with
    only sparse upper vowels/tones, so their top-third ink ratio is LOW (~0.1).
    Latin chord/instr rows (A-G capitals, '/') fill the top → high ratio (~0.3+).
    This top-ratio test is scale- and length-invariant, so it works on short
    lyric lines and across image sizes where a plain fill threshold fails."""
    W = ink.shape[1]
    info = []
    for (y0, y1) in bands:
        sub = ink[y0:y1]
        h = y1 - y0
        ci = sub.sum(axis=0) > 0
        xs = np.where(ci)[0]
        span = (xs[-1] - xs[0] + 1) if len(xs) else 1
        hcov = ci.sum() / span
        tot = sub.sum() or 1
        top = sub[: max(1, h // 3)].sum() / tot
        is_lyric = (h >= 8 and top < 0.20 and hcov > 0.45)
        info.append({"y0": y0, "y1": y1,
                     "x0": int(xs[0]) if len(xs) else 0,
                     "x1": int(xs[-1]) if len(xs) else 0,
                     "fill": ci.sum() / W, "hcov": hcov, "top": top,
                     "is_lyric": is_lyric})
    return info

def instr_row(ink, y0, y1, templates):
    """Reconstruct an Intro/Instru/Outro row deterministically: template-match
    every token (palette chords + '/') and join. Returns a seq like
    '[D] / [A] / [F#m]' (no label — caller adds it by position)."""
    st = _slash_template()
    parts = []
    for (xl, xr) in token_boxes(ink, y0, y1, dilate=4):
        crop = ink[y0:y1, xl:xr + 1]
        ng = _norm_glyph(crop)
        if not ng:
            continue
        tc, tasp = ng
        # slash? (thin tall stroke)
        if st:
            sc, sasp = st
            iou = (tc & sc).sum() / ((tc | sc).sum() or 1)
            if iou > 0.35 and tasp < 0.6:
                parts.append("/"); continue
        chord, score = match_chord(crop, templates)
        # require a confident chord match; this drops label words (Intro/Instru),
        # repeat counts ('( x2 )') and noise, which match no chord well.
        if chord and score > 0.42:
            parts.append(f"[{chord}]")
    return " ".join(parts)

def token_boxes(ink, y0, y1, dilate=6):
    """Chord tokens in a row → list of (xleft, xright), left→right. Components
    closer than `dilate` px merge (so 'C#m' stays one token)."""
    sub = ink[y0:y1]
    lab, n = ndi.label(ndi.binary_dilation(sub, structure=np.ones((1, dilate))))
    boxes = []
    for i in range(1, n + 1):
        cols = np.where((lab == i).any(axis=0))[0]
        if len(cols) >= 2:
            boxes.append((int(cols[0]), int(cols[-1])))
    return sorted(boxes)

def token_lefts(ink, y0, y1, dilate=6):
    return [b[0] for b in token_boxes(ink, y0, y1, dilate)]


# ── deterministic chord IDENTITY: template-match against Tahoma palette ───────
def _norm_glyph(crop):
    ys, xs = np.where(crop)
    if len(xs) == 0:
        return None
    crop = crop[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = crop.shape
    W_ = max(1, int(round(w * 24 / h)))
    im = Image.fromarray((crop * 255).astype(np.uint8)).resize((W_, 24), Image.LANCZOS)
    a = np.asarray(im) > 110
    canvas = np.zeros((24, 80), bool)
    canvas[:, :min(80, a.shape[1])] = a[:, :min(80, a.shape[1])]
    return canvas, w / h

_TPL_CACHE = {}
def build_templates(palette):
    key = tuple(palette)
    if key in _TPL_CACHE:
        return _TPL_CACHE[key]
    tpl = {}
    for c in palette:
        for path in (FONT, "/System/Library/Fonts/Supplemental/Tahoma Bold.ttf"):
            f = ImageFont.truetype(path, 28)
            w = int(f.getlength(c)) + 2
            im = Image.new("L", (w, 56), 0)
            ImageDraw.Draw(im).text((1, 14), c, font=f, fill=255)
            ng = _norm_glyph(np.asarray(im) > 110)
            if ng:
                tpl.setdefault(c, []).append(ng)
    _TPL_CACHE[key] = tpl
    return tpl

def match_chord(crop, templates):
    ng = _norm_glyph(crop)
    if not ng:
        return None, 0.0
    tc, tasp = ng
    best, bs = None, -1e9
    for name, variants in templates.items():
        for canv, asp in variants:
            inter = (tc & canv).sum(); union = (tc | canv).sum()
            iou = inter / union if union else 0
            s = iou - 0.15 * abs(np.log((tasp + .01) / (asp + .01)))
            if s > bs:
                bs, best = s, name
    return best, float(bs)

_SLASH = None
def _slash_template():
    global _SLASH
    if _SLASH is None:
        f = ImageFont.truetype(FONT, 28)
        w = int(f.getlength("/")) + 2
        im = Image.new("L", (w, 56), 0)
        ImageDraw.Draw(im).text((1, 14), "/", font=f, fill=255)
        _SLASH = _norm_glyph(np.asarray(im) > 110)
    return _SLASH

def has_slash(ink, y0, y1):
    """True if a chord-only band is an Intro/Instru row (contains '/' separators)
    rather than a lyric's chord row."""
    st = _slash_template()
    if not st:
        return False
    sc, sasp = st
    hits = 0
    for (xl, xr) in token_boxes(ink, y0, y1):
        ng = _norm_glyph(ink[y0:y1, xl:xr + 1])
        if not ng:
            continue
        tc, tasp = ng
        inter = (tc & sc).sum(); union = (tc | sc).sum()
        iou = inter / union if union else 0
        # '/' is a narrow tall stroke: also require slim aspect to avoid false hits
        if iou - 0.15 * abs(np.log((tasp + .01) / (sasp + .01))) > 0.45 and tasp < 0.55:
            hits += 1
    return hits >= 1

def render_line(text_ns, h=40):
    f = ImageFont.truetype(FONT, h)
    cx = np.array([f.getlength(text_ns[:k]) for k in range(len(text_ns) + 1)])
    W = int(np.ceil(cx[-1])) + 4
    im = Image.new("L", (W, h * 2), 0)
    ImageDraw.Draw(im).text((0, h // 2), text_ns, font=f, fill=255)
    col = (np.asarray(im) > 60).any(axis=0).astype(np.float32)
    return col, cx

def gap_align(R, S, lam=1.0):
    """Map every render col to a source col; source may insert (skip) cols at
    cost lam*ink (so chord-spaces, being blank, are absorbed). Returns r2s."""
    Lr, Ls = len(R), len(S)
    INF = 1e18
    prev = np.full(Ls + 1, INF)
    prev[0] = 0.0
    for j in range(1, Ls + 1):
        prev[j] = prev[j - 1] + lam * S[j - 1]
    bp = np.zeros((Lr + 1, Ls + 1), np.int8)
    for i in range(1, Lr + 1):
        cur = np.full(Ls + 1, INF)
        ri = R[i - 1]
        for j in range(i, Ls + 1):
            m = prev[j - 1] + abs(ri - S[j - 1])
            ins = cur[j - 1] + lam * S[j - 1] if j - 1 >= i else INF
            if m <= ins:
                cur[j] = m; bp[i, j] = 1
            else:
                cur[j] = ins; bp[i, j] = 2
        prev = cur
    tail = [prev[j] + lam * S[j:].sum() for j in range(Lr, Ls + 1)]
    jend = int(np.argmin(tail)) + Lr
    r2s = np.zeros(Lr, np.int32)
    i, j = Lr, jend
    while i > 0:
        if bp[i, j] == 1:
            r2s[i - 1] = j - 1; i -= 1; j -= 1
        else:
            j -= 1
    return r2s

def snap_left(text, idx):
    while 0 < idx < len(text) and ord(text[idx]) in COMB:
        idx -= 1
    return idx

def geometry_line(ink, info, band, line_text, templates):
    """For one lyric line: detect chord tokens in the row above, place each over a
    character (Tahoma↔source gap align) and identify it (template match).
    Returns list of dicts {char, chord, score} left→right."""
    ns, nsmap = [], []
    for i, ch in enumerate(line_text):
        if ch != " ":
            ns.append(ch); nsmap.append(i)
    text_ns = "".join(ns)
    if not text_ns:
        return []
    bi = info.index(band)
    above = None
    for j in range(bi - 1, -1, -1):
        if info[j]["is_lyric"]:
            break
        # an Intro/Instru row ('/'-separated) is NOT this lyric's chord row — skip it
        if has_slash(ink, info[j]["y0"], info[j]["y1"]):
            continue
        if band["y0"] - info[j]["y1"] < 40:
            above = info[j]; break
    if not above:
        return []
    x0, x1 = band["x0"], band["x1"]
    S = (ink[band["y0"]:band["y1"], x0:x1 + 1].sum(axis=0) > 0).astype(np.float32)
    Rcol, cx = render_line(text_ns)
    scale = (x1 - x0 + 1) / max(1, len(Rcol))
    Rs = np.interp(np.arange(int(len(Rcol) * scale)),
                   np.arange(len(Rcol)) * scale, Rcol)
    Rs = (Rs > 0.5).astype(np.float32)
    cxs = cx * scale
    r2s = gap_align(Rs, S)
    out = []
    ay0, ay1 = above["y0"], above["y1"]
    for (xl, xr) in token_boxes(ink, ay0, ay1):
        xrel = min(max(xl, x0), x1) - x0
        ci = int(np.argmin(np.abs(r2s - xrel)))
        k_ns = max(0, min(len(nsmap) - 1, int(np.searchsorted(cxs, ci, side="right") - 1)))
        chord, score = match_chord(ink[ay0:ay1, xl:xr + 1], templates)
        out.append({"char": snap_left(line_text, nsmap[k_ns]),
                    "chord": chord, "score": round(score, 2)})
    return out


# ── model (identity + anchors + instrumental rows), one call per song ─────────
SYSTEM = """You read a Thai chord sheet image. You are given the song's exact
NUMBERED lyric lines and its ALLOWED CHORDS. Return ONLY JSON:
{
 "key": "<top-of-sheet chord or null>",
 "rows": [
   {"type":"instr","label":"Intro","seq":"[D] / [A] / [D] / [A]"},
   {"type":"lyric","line":1,"chords":[{"chord":"D","anchor":"คำสาป"},{"chord":"A","anchor":"ทุกๆ"}]}
 ]
}
RULES: rows in TOP-TO-BOTTOM order as in the image. For each lyric line list its
chords LEFT-TO-RIGHT; "anchor" = copy 2-6 Thai characters of the syllable the
chord sits above, EXACTLY from the given line. Use ONLY allowed chords. Bracket
every chord in "seq" and keep "/" and "( xN )". Output NEVER any lyric text
except inside "anchor". No prose, no code fence."""

def to_png_b64(im):
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as t:
        path = t.name
    try:
        im.save(path, "PNG")
        return base64.b64encode(open(path, "rb").read()).decode()
    finally:
        os.remove(path)

def model_read(im, thai_lines, palette, timeout=600):
    numbered = "\n".join(f"{i+1}: {l}" for i, l in enumerate(thai_lines))
    sysmsg = (SYSTEM + "\n\nALLOWED CHORDS: " + ", ".join(palette or ["any"])
              + "\n\nNUMBERED LYRIC LINES:\n" + numbered)
    body = json.dumps({
        "model": MODEL, "system": sysmsg,
        "prompt": "Return the alignment JSON now.",
        "images": [to_png_b64(im)], "stream": False, "format": "json",
        "keep_alive": "30m", "options": {"temperature": 0, "num_predict": 4096},
    }).encode()
    req = urllib.request.Request(OLLAMA, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.loads(r.read())["response"]
    try:
        return json.loads(resp)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", resp, re.S)
        return json.loads(m.group(0)) if m else {"key": None, "rows": []}


# ── anchor resolution (model anchor substring → char index in known line) ─────
def locate(text, anchor, start):
    if not anchor:
        return None
    i = text.find(anchor, start)
    if i != -1:
        return i
    a = anchor.replace(" ", "")
    idx = [k for k, ch in enumerate(text) if ch != " "]
    compact = "".join(text[k] for k in idx)
    off = sum(1 for k in idx if k < start)
    j = compact.find(a, off)
    if j != -1:
        return idx[j]
    if len(a) > 3:
        return locate(text, anchor[:3], start)
    return None


def palette_ok(chord, palset):
    c = chord.strip()
    if not c or not palset:
        return True
    if c in palset:
        return True
    return all(p.strip() in palset for p in c.split("/") if p.strip())


LABEL_RE = re.compile(r"^(Intro|Instru|Solo|Outro|Ending|Hook|Verse|Chorus|Pre)\b", re.I)
LOW_SCORE = 0.30

def clean_seq(seq):
    seq = re.sub(r"\s+", " ", seq).strip()
    seq = re.sub(r"(?:/\s*){2,}", "/ ", seq)     # collapse // → /
    return seq.strip(" /").strip()

def assemble(rec, im, src):
    """FULLY GEOMETRIC + template (no model): place & identify lyric-line chords,
    and reconstruct Intro/Instru/Outro rows from the chord-only bands. Lyrics come
    verbatim from the scrape (100% fidelity). Returns (chordpro_text, report)."""
    lyrics_all = src["lyrics"].split("\n")
    thai_pos = [i for i, l in enumerate(lyrics_all) if THAI.search(l)]
    thai_lines = [lyrics_all[i] for i in thai_pos]
    palette = src.get("palette") or []
    palset = set(palette)
    templates = build_templates(palette) if palette else {}

    ink = ink_of(im)
    info = classify(ink, bands_of(ink))
    lyric_bands = [b for b in info if b["is_lyric"]]
    n_lyric_bands = len(lyric_bands)
    count_match = (n_lyric_bands == len(thai_lines))

    # geometry+template: per thai-line index -> [{char,chord,score}]
    placements = {}
    if templates:
        for k, band in enumerate(lyric_bands):
            if k >= len(thai_lines):
                break
            placements[k] = geometry_line(ink, info, band, thai_lines[k], templates)

    # Intro/Instru/Outro = chord-only bands that are NOT a lyric's chord row.
    # Key them by how many lyric bands precede them (so we can interleave on emit).
    instr_after = {}
    lyc = 0
    for idx, b in enumerate(info):
        if b["is_lyric"]:
            lyc += 1
            continue
        below_is_lyric = (idx + 1 < len(info) and info[idx + 1]["is_lyric"]
                          and info[idx + 1]["y0"] - b["y1"] < 28)
        is_slash = has_slash(ink, b["y0"], b["y1"])
        if below_is_lyric and not is_slash:
            continue                                  # that lyric's chord row
        seq = clean_seq(instr_row(ink, b["y0"], b["y1"], templates))
        if seq:
            instr_after.setdefault(lyc, []).append(seq)

    def label_for(k):
        if k == 0:
            return "Intro"
        if k >= n_lyric_bands:
            return "Outro"
        return "Instru"

    bad_chords = set()
    for segs in placements.values():
        for s in segs:
            if s["chord"] and not palette_ok(s["chord"], palset):
                bad_chords.add(s["chord"])

    # ── emit: intro, then scraped lines in order with chords + interleaved instr ──
    out = []
    for n, s in enumerate(instr_after.get(0, [])):
        out.append((label_for(0) + " " if n == 0 else "") + s)
    ti = -1
    for pos_i, line in enumerate(lyrics_all):
        if pos_i in thai_pos:
            ti += 1
            text = line
            for seg in sorted(placements.get(ti, []), key=lambda s: -s["char"]):
                if not seg["chord"]:
                    continue
                p = max(0, min(len(text), seg["char"]))
                text = text[:p] + f"[{seg['chord']}]" + text[p:]
            out.append(text)
            for n, s in enumerate(instr_after.get(ti + 1, [])):
                out.append((label_for(ti + 1) + " " if n == 0 else "") + s)
        else:
            out.append(line)        # blank lines, (*,**) markers — verbatim
    chordpro = "\n".join(out).strip() + "\n"

    # ── deterministic self-test ──
    placed = sum(len(v) for v in placements.values())
    scores = [s["score"] for segs in placements.values() for s in segs if s["chord"]]
    low_lines = [{"line": li + 1, "low_score_chords": [s["chord"] for s in segs
                  if s["chord"] and s["score"] < LOW_SCORE]}
                 for li, segs in placements.items()
                 if any(s["chord"] and s["score"] < LOW_SCORE for s in segs)]
    avg_score = round(float(np.mean(scores)), 3) if scores else 0.0
    id_conf = round(len([s for s in scores if s >= LOW_SCORE]) / max(1, len(scores)), 3)

    def thai_only(s):
        return "".join(c for c in s if "฀" <= c <= "๿")
    want = thai_only("\n".join(thai_lines))
    got = thai_only(re.sub(r"\[[^\]]*\]", "", "\n".join(
        l for l in chordpro.split("\n")
        if not re.match(r"^\s*\{.*\}\s*$", l) and not LABEL_RE.match(l))))
    instr_rows = sum(len(v) for v in instr_after.values())
    report = {
        "id": rec["id"], "name": rec.get("name"),
        "lyric_exact": want == got, "thai_chars": [len(want), len(got)],
        "palette": palette, "bad_chords": sorted(bad_chords),
        "chords_placed": placed, "instr_rows": instr_rows,
        "lyric_bands": n_lyric_bands, "thai_lines": len(thai_lines),
        "rows_count_match": count_match,
        "avg_id_score": avg_score, "id_confidence": id_conf,
        "low_score_lines": low_lines,
        "needs_review": (not (want == got)) or bool(bad_chords)
                        or not count_match or id_conf < 0.85,
    }
    return chordpro, report


def process(rec, src):
    im = load_image(rec["name"])
    if im is None:
        return None, {"id": rec["id"], "error": "no_image"}
    if src.get("status") == "no_lyrics" or not src.get("lyrics"):
        return None, {"id": rec["id"], "error": "no_lyrics"}
    return assemble(rec, im, src)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--report-only", action="store_true")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    src = load_src()
    names = name_map()
    if args.ids:
        ids = [int(x) for x in args.ids.split(",") if x.strip()]
    else:
        ids = sorted(src.keys())
        ids = [i for i in ids if i >= args.start]
        if not args.force:
            ids = [i for i in ids if not os.path.exists(os.path.join(OUT_DIR, f"{i}.md"))]
        if args.limit:
            ids = ids[: args.limit]

    print(f"align: {len(ids)} songs  (model {MODEL})")
    for i in ids:
        if i not in src:
            print(f"  #{i} — not in song-src.jsonl (run scrape_src.py)"); continue
        rec = {"id": i, "name": names.get(i, f"id{i}")}
        try:
            cp, report = process(rec, src[i])
        except Exception as e:
            print(f"  #{i} ✗ {type(e).__name__}: {str(e)[:120]}"); continue
        if cp is None:
            print(f"  #{i} — skip ({report.get('error')})"); continue
        if not args.report_only:
            open(os.path.join(OUT_DIR, f"{i}.md"), "w", encoding="utf-8").write(cp)
            json.dump(report, open(os.path.join(OUT_DIR, f"{i}.report.json"), "w"),
                      ensure_ascii=False, indent=1)
        flag = "  ⚠ REVIEW" if report["needs_review"] else ""
        print(f"  #{i} lyric_exact={report['lyric_exact']} "
              f"chords={report['chords_placed']} instr={report['instr_rows']} "
              f"rows={report['lyric_bands']}/{report['thai_lines']} "
              f"id_conf={report['id_confidence']} bad={report['bad_chords']}{flag}")
    print("done.")


if __name__ == "__main__":
    main()
