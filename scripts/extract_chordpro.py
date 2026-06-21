#!/usr/bin/env python3
"""
Extract a chord-sheet IMAGE → ChordPro TEXT (offline).

Pipeline (per song id on chordtabs.in.th):
  1. Lyrics + STRUCTURE from the page HTML (2nd #divlyric): perfect Thai text,
     blank-line spacing, section indentation, * / ** markers — zero OCR.
  2. Chord VOCABULARY from the page's chord-diagram <img> links (the song's exact
     chord set), used to repair OCR misreads via music theory.
  3. Watermark removal (threshold) → clean black-on-white.
  4. Chord DETECTION + NAMES via an ENGLISH-only EasyOCR reader (the Thai model
     corrupts chord glyphs); two detector passes unioned for recall; merged
     chord boxes re-split; names snapped to the page vocabulary.
  5. PLACEMENT: each chord mapped to the real Thai WORD it floats above
     (pythainlp word boundaries + zero-width Thai marks), padded so it lands on
     ~its image column without overlapping neighbours; chords past the last word
     float as trailing chords.
  6. Output = inline ChordPro the app's parseChordpro()/ChordSheet renders.

USAGE (needs Python 3.11 with: easyocr torch pythainlp pillow requests numpy)
  py -3.11 scripts/extract_chordpro.py 48 100 2289      # specific ids
  py -3.11 scripts/extract_chordpro.py --range 1 200    # an id range
  py -3.11 scripts/extract_chordpro.py --missing --limit 50  # next 50 un-extracted songs (re-run to continue)
  py -3.11 scripts/extract_chordpro.py 48                # GPU auto: uses CUDA whenever it's available
  py -3.11 scripts/extract_chordpro.py 48 --cpu         # force CPU even if CUDA is available
  py -3.11 scripts/extract_chordpro.py 48 --out data/chordpro --print

Output: one <out>/<id>.txt per song (UTF-8 ChordPro). HTML+image are cached
under <cache>/ so re-runs and retries don't re-hit (or get blocked by) the site.
"""
import argparse, html as H, json, os, re, sys, time
from io import BytesIO
from urllib.parse import urljoin

import numpy as np
import requests
from PIL import Image
from pythainlp.tokenize import word_tokenize
import easyocr

HDR = {'User-Agent': 'Mozilla/5.0 Chrome/124.0', 'Referer': 'https://chordtabs.in.th/'}
NBSP = ' '                      # non-collapsing space (survives the renderer's fit-mode nowrap)
MARKER = re.compile(r'^[\*\(\)\d/\s\.\-]+$')

def has_thai(s): return any('฀' <= c <= '๿' for c in s)
def is_comb(ch): return ch == 'ั' or 'ิ' <= ch <= 'ฺ' or '็' <= ch <= '๎'

def vis_cols(s):
    cols, c = [], 0
    for ch in s:
        cols.append(c)
        if not is_comb(ch): c += 1
    cols.append(c)
    return cols, c

# --- chord grammar (theory-aware): maj7/maj BEFORE m so "Ebmaj7" isn't eaten as "Ebm" ---
_QUAL = r'(?:maj7|maj9|maj|mmaj7|m7b5|m7|m9|m6|madd9|m|add9|sus2|sus4|sus|dim7|dim|aug|6|7|9|2|4|\+)'
CHORD_RE = r'[A-Ga-g][#b]?' + _QUAL + r'?(?:/[A-Ga-g][#b]?)?'
CHORD_TOK = re.compile(CHORD_RE)
WEIRD_ROOT = re.compile(r'^(E#|B#|Cb|Fb)')

def _split(c):
    if not c: return None
    c = c.strip().strip('.').replace('|', '').replace('Fem', 'F#m').replace('fem', 'F#m')
    m = re.match(r'^([A-Ga-g])([#b]?)(.*)$', c)
    if not m: return None
    root, acc, rest = m.group(1).upper(), m.group(2), m.group(3)
    bass = ''
    if '/' in rest:
        rest, _, b = rest.partition('/')
        mb = re.match(r'([A-Ga-g])([#b]?)', b)
        if mb: bass = '/' + mb.group(1).upper() + mb.group(2)
    qm = re.match(_QUAL, rest)
    return root, acc, (qm.group(0) if qm else ''), bass

def snap(t):
    s = _split(t)
    return (s[0] + s[1] + s[2] + s[3]) if s else None

def is_chord(t):
    t = t.strip().strip('.').replace(' ', '').replace('|', '').replace('fem', 'f#m').replace('Fem', 'F#m')
    return bool(re.fullmatch(CHORD_RE, t)) and not has_thai(t)

def chords_in_box(text, x0, x1):
    t = re.sub(r'[.,:;=_]', '', text.replace('fem', 'f#m').replace('Fem', 'F#m'))
    t = t.replace('z', '7').replace('Z', '7')   # OCR reads the chord "7" as z (F#mz→F#m7, majz→maj7)
    # recover a slash chord whose "/" the OCR read as l / I / |  (e.g. "ElG#" → "E/G#"):
    # otherwise it splits into TWO chords (E + a spurious bass-note G#).
    t = re.sub(r'([A-Ga-g][#b]?)[lI|]([A-G][#b]?)\b', r'\1/\2', t)
    if has_thai(t) or not t.strip(): return []
    ms = list(CHORD_TOK.finditer(t))
    if not ms: return []
    if sum(m.end() - m.start() for m in ms) < 0.6 * len(t.replace(' ', '')): return []
    L, w, res = max(1, len(t)), x1 - x0, []
    for m in ms:
        nm = snap(m.group())
        if nm: res.append((nm, x0 + m.start() / L * w, x0 + (m.start() + m.end()) / 2 / L * w))
    return res

def _prefix_len(a, b):
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]: n += 1
    return n

def snap_vocab(nm, vocab):
    if not vocab or nm in vocab: return nm
    s = _split(nm)
    if s and s[3]: return nm                                   # slash chord → keep
    if s:
        root, acc, qual, _ = s
        same = [(v, _split(v)[2]) for v in vocab
                if _split(v) and not _split(v)[3] and _split(v)[0] == root and _split(v)[1] == acc]
        # Only COMPLETE a reading that's a less-specific/mangled form of a listed chord
        # (its quality is a prefix of the vocab chord's): "Eb"→Eb7, "Ebm"→Ebmaj7. A reading
        # MORE specific than any listed chord (e.g. "F#mmaj7" when vocab has only F#m/F#m6/F#m7)
        # is a real chord the diagram list just omitted → trust it, don't snap it down.
        compl = [(v, vq) for v, vq in same if vq.startswith(qual)]
        if compl:
            return min(compl, key=lambda x: len(x[1]))[0]
        if not WEIRD_ROOT.match(nm): return nm                 # clean chord, vocab can't complete it → trust
    pp = s or ('', '', '', '')
    best, bs = nm, -10
    for v in vocab:
        q = _split(v)
        if not q: continue
        sc = (q[1] == pp[1]) + 2 * ((q[2] == 'm') == (pp[2] == 'm')) + (q[0] == pp[0])
        if sc > bs: best, bs = v, sc
    return best

INSTR_KW = re.compile(r'^(intro|verse|chorus|prechorus|bridge|outro|ending|coda|solo|interlude|instru(?:mental)?|hook|tag|riff)$', re.I)
INSTR_FIX = [(r'\bdutro\b', 'outro'), (r'\boxtro\b', 'outro'), (r'\blnstru\b', 'instru'),
             (r'\binsttu\b', 'instru'), (r'\blntro\b', 'intro'), (r'\bintrd\b', 'intro'), (r'\bintru\b', 'intro')]

def fmt_instr(text, vocab=None):
    t = re.sub(r'[.:;=_]', '', text).strip()
    for pat, rep in INSTR_FIX: t = re.sub(pat, rep, t, flags=re.I)
    # section-repeat marker line — "( * )", "( *, ** )" — often OCRs with ')'→'3' or '*'→'#'
    # ("(*,*,*,3", "(##)"). Rebuild it from its star groups so the noise can't leak through.
    if re.fullmatch(r'[()*#,\s\d]*[*#][()*#,\s\d]*', t):
        groups = re.findall(r'[*#]+', t)
        if groups: return '( ' + ', '.join('*' * len(g) for g in groups) + ' )'
    out = ''
    for p in re.split(r'([\s/|()\[\]])', t):
        ps = p.strip()
        psd = ps.lstrip('0123456789')          # "/ G" often OCRs as "6G"/"1B" (slash→digit)
        if ps and is_chord(ps): out += '[' + snap_vocab(snap(ps), vocab) + ']'
        elif ps and psd != ps and is_chord(psd): out += '[' + snap_vocab(snap(psd), vocab) + ']'
        elif INSTR_KW.match(ps): out += ps.capitalize()
        else: out += p
    return re.sub(r'\s+', ' ', out).strip()

def clean_note(t):
    t = re.sub(r'\s+', ' ', re.sub(r'[|]', '', t)).strip()
    t = re.sub(r'\bv[z2]\b', '½', t, flags=re.I).replace('1/2', '½')
    return t[:1].upper() + t[1:] if t else t

def fetch(sid, cache_dir):
    cache = os.path.join(cache_dir, f'{sid}.html')
    html = None
    try:
        h = requests.get(f'https://chordtabs.in.th/{sid}/', headers=HDR, timeout=20).text
        if 'divlyric' in h:
            html = h
            open(cache, 'w', encoding='utf-8').write(h)
    except Exception:
        pass
    if html is None and os.path.exists(cache):
        html = open(cache, encoding='utf-8').read()
    if html is None or 'ไม่มีเนื้อเพลง' in html: return None
    img = re.search(r'id="divlyric"[^>]*>\s*<img[^>]*src="([^"]+)"', html).group(1)
    mt = re.search(r'<img[^>]*alt="คอร์ด\s*([^"]+)"', html)
    title = H.unescape(mt.group(1)).strip() if mt else None
    vocab = set()
    for raw in re.findall(r'/img/chord/[^"\']+?/([^/"\']+?)\.(?:webp|png|gif)', html):
        v = raw.replace('-sharp-', '#').replace('-flat-', 'b').strip('-')
        if re.fullmatch(r'[A-G][#b]?m?(?:7|maj7|sus[24]?|dim|aug|9|6)?(?:/[A-G][#b]?)?', v): vocab.add(v)
    blk = html.split('id="divlyric"')[-1].split('class="container"')[0]
    blk = re.sub(r'<h3.*?</h3>', '', blk, flags=re.S).replace('&nbsp;', '\x00')
    blk = re.sub(r'<br\s*/?>', '\n', blk, flags=re.I)
    blk = re.sub(r'</(div|p)>', '\n', blk, flags=re.I)
    blk = H.unescape(re.sub(r'<[^>]+>', '', blk))
    skel = []
    for r in blk.split('\n'):
        bare = r.lstrip('\x00 \t')
        indent = r[:len(r) - len(bare)].count('\x00')
        text = re.sub(r'[ \t]+', ' ', bare.replace('\x00', ' ')).strip(' >')
        if not text:
            if not (skel and skel[-1].get('blank')): skel.append({'blank': True})
        elif has_thai(text):
            skel.append({'lyric': True, 'indent': indent, 'text': text})
    while skel and skel[0].get('blank'): skel.pop(0)
    while skel and skel[-1].get('blank'): skel.pop()
    return dict(img=img, skel=skel, sung=[r['text'] for r in skel if r.get('lyric')], title=title, vocab=vocab)

def ocr_pass(reader, base_gray, s, **kw):
    im = base_gray.resize((base_gray.width * s, base_gray.height * s), Image.LANCZOS)
    im = im.point(lambda p: 0 if p < 135 else 255).convert('RGB')
    out = []
    for b, text, conf in reader.readtext(np.array(im), **kw):
        xs = [p[0] for p in b]; ys = [p[1] for p in b]
        out.append(dict(text=text.strip(), x0=min(xs) / s, x1=max(xs) / s,
                        cx=(min(xs) + max(xs)) / 2 / s, yc=(min(ys) + max(ys)) / 2 / s, conf=conf))
    return out

PASSES = [dict(s=2, low_text=0.2, text_threshold=0.4, mag_ratio=1.5),
          dict(s=3, low_text=0.2, text_threshold=0.4, mag_ratio=1.5, add_margin=0.15)]

def _lblcols(nm): return 1   # The RENDERER (ChordSheet) now reserves each chord-label's real
                             # width (inline-block columns), so the text only needs chords at
                             # distinct columns — no baked-in label-clearance padding (which would
                             # double-space). Positioning still aligns to the image column.

def place_line(full, row, rowchords):
    Lx0 = min(b['x0'] for b in row); Lx1 = max(b['x1'] for b in row); span = max(1.0, Lx1 - Lx0)
    cols, W = vis_cols(full)
    toks = word_tokenize(full, engine='newmm', keep_whitespace=True)
    offs, p = [], 0
    for t in toks:
        offs.append(p); p += len(t)
    starts = [(offs[k], cols[offs[k]]) for k, t in enumerate(toks) if t.strip() and not MARKER.match(t)] or [(0, 0)]
    # PIECEWISE pixel→column map: apportion the lyric's visual columns among the OCR sub-boxes
    # (in x-order) by each box's text length, so a chord lands by the actual SEGMENT it floats
    # over — far more accurate on long lines with phrase gaps than one uniform stretch.
    pcs = sorted(row, key=lambda b: b['x0'])
    lens = [max(1, vis_cols(b['text'])[1]) for b in pcs]
    tot = sum(lens)
    anchors, acc = [], 0.0
    for b, ln in zip(pcs, lens):
        wc = W * ln / tot
        anchors += [(b['x0'], acc), (b['x1'], acc + wc)]; acc += wc
    anchors.sort()
    for i in range(1, len(anchors)):                 # keep columns monotonic if boxes overlap
        if anchors[i][1] < anchors[i - 1][1]: anchors[i] = (anchors[i][0], anchors[i - 1][1])
    def px_to_col(px):
        if px <= anchors[0][0]: return anchors[0][1]
        if px >= anchors[-1][0]: return anchors[-1][1]
        for (xa, ca), (xb, cb) in zip(anchors, anchors[1:]):
            if xa <= px <= xb: return ca + (cb - ca) * (px - xa) / (xb - xa) if xb > xa else ca
        return anchors[-1][1]
    colw = span / max(1, W)                           # avg px/column, for trailing extrapolation
    inserts, trailing = [], []
    for c in sorted(rowchords, key=lambda c: c['cx']):
        if c['cx'] > Lx1 + 1.5 * colw:                # past the last lyric box → trailing chord
            trailing.append((W + (c['cx'] - Lx1) / colw, c['nm'])); continue
        ccol = px_to_col(c['cx'])
        le = [st for st in starts if st[1] <= ccol]
        inserts.append([le[-1][0] if le else starts[0][0], c['nm'], ccol])
    all_offs = [st[0] for st in starts]
    for k in range(1, len(inserts)):
        if inserts[k][0] <= inserts[k - 1][0]:
            nxt = [o for o in all_offs if o > inserts[k - 1][0]]
            inserts[k][0] = nxt[0] if nxt else len(full)
    s, prev, pad, last_col, last_w = '', 0, 0, -999, 0
    for off, nm, tcol in inserts:
        s += full[prev:off]
        cur = cols[off] + pad
        target = max(round(tcol), last_col + last_w)
        if target - cur > 0:
            add = min(target - cur, 24); s += NBSP * add; pad += add; cur += add
        s += '[' + nm + ']'; prev = off
        last_col, last_w = cur, _lblcols(nm)
    s += full[prev:]
    # trailing chords (past the lyrics): gap = at least the PREVIOUS label's width so a
    # wide name like "E/G#" never collides with the next chord.
    prevcol, prev_w = W, 2
    for ccol, nm in trailing:
        s += NBSP * min(20, max(prev_w, round(ccol - prevcol))) + '[' + nm + ']'
        prevcol, prev_w = ccol, _lblcols(nm)
    return s

# Versions. PIPE_V = post-processing (assemble) rules — bump on rule changes; `--regen`
# cheaply rebuilds ChordPro from cached raw/. OCR_V = detection — bump only when ocr_raw()
# changes; that's the rare case that needs a (cached-image) re-OCR.
PIPE_V, OCR_V = 1, 1

def ocr_raw(sid, readers, cache_dir):
    """EXPENSIVE step (~50s/song): fetch page+image, run OCR. Returns a JSON-able 'raw
    intermediate' (every OCR detection + the HTML facts) — enough to rebuild the ChordPro
    later WITHOUT re-OCR. None if the song has no lyrics."""
    reader_en, reader_th = readers
    res = fetch(sid, cache_dir)
    if res is None: return None
    imgcache = os.path.join(cache_dir, f'{sid}.png')
    if os.path.exists(imgcache):
        base = Image.open(imgcache).convert('L')
    else:
        r = requests.get(urljoin('https://chordtabs.in.th/', res['img']), headers=HDR, timeout=30)
        open(imgcache, 'wb').write(r.content)
        base = Image.open(BytesIO(r.content)).convert('L')
    rnd = lambda L: [{k: (round(v, 1) if isinstance(v, float) else v) for k, v in b.items()} for b in L]
    return {'id': sid, 'ocr_v': OCR_V, 'title': res['title'], 'vocab': sorted(res['vocab']),
            'skel': res['skel'], 'sung': res['sung'],
            'en1': rnd(ocr_pass(reader_en, base, 2, low_text=0.2, text_threshold=0.4, mag_ratio=1.5)),
            'en2': rnd(ocr_pass(reader_en, base, 3, low_text=0.2, text_threshold=0.4, mag_ratio=1.5, add_margin=0.15)),
            'th':  rnd([b for b in ocr_pass(reader_th, base, 2, low_text=0.2, text_threshold=0.4, mag_ratio=1.5)
                        if has_thai(b['text'])])}

def assemble(raw, ov=None, warn=None):
    """CHEAP step (ms): raw intermediate (+ optional per-song overrides) → ChordPro text.
    No OCR — re-runnable over every cached raw/ to apply any rule fix in minutes."""
    vocab = set(raw['vocab']); skel = raw['skel']; sung = raw['sung']
    chords = []
    for b in raw['en1'] + raw['en2']:
        for nm, x0c, cxc in chords_in_box(b['text'], b['x0'], b['x1']):
            nm = snap_vocab(nm, vocab)
            dup = next((c for c in chords if c['nm'] == nm and abs(c['cx'] - cxc) < 14 and abs(c['yc'] - b['yc']) < 12), None)
            if dup:
                if b['conf'] > dup['conf']: dup.update(nm=nm, x0=x0c, cx=cxc, yc=b['yc'], conf=b['conf'])
            else:
                chords.append(dict(nm=nm, x0=x0c, cx=cxc, yc=b['yc'], conf=b['conf']))
    lyrics = sorted((b for b in raw['th'] if has_thai(b['text']) and sum('฀' <= ch <= '๿' for ch in b['text']) >= 2),
                    key=lambda b: b['yc'])
    rows, cur = [], []
    for b in lyrics:
        if cur and b['yc'] - cur[-1]['yc'] > 14: rows.append(cur); cur = []
        cur.append(b)
    if cur: rows.append(cur)
    rows = [sorted(r, key=lambda b: b['x0']) for r in rows]
    row_y = [sum(b['yc'] for b in r) / len(r) for r in rows]
    row_chords = [[] for _ in rows]
    for c in chords:
        cand = [i for i in range(len(rows)) if 4 < (row_y[i] - c['yc']) < 45]
        if cand: row_chords[min(cand, key=lambda i: row_y[i])].append(c)
    placed = [place_line(sung[li], rows[li], row_chords[li]) for li in range(min(len(rows), len(sung)))]
    while len(placed) < len(sung): placed.append(sung[len(placed)])
    note, instr = None, []
    nonthai = sorted((b for b in raw['en1'] if not has_thai(b['text']) and b['text'].strip()), key=lambda b: b['yc'])
    irows, cur = [], []
    for b in nonthai:
        if cur and b['yc'] - cur[-1]['yc'] > 10: irows.append(cur); cur = []
        cur.append(b)
    if cur: irows.append(cur)
    for ir in irows:
        ir = sorted(ir, key=lambda b: b['x0'])
        txt = ' '.join(b['text'] for b in ir); iy = sum(b['yc'] for b in ir) / len(ir); low = txt.lower()
        if 'tune' in low or 'tone' in low: note = clean_note(txt); continue
        if any(abs(ry - iy) < 14 for ry in row_y): continue
        # A parenthesised section-repeat marker — "( *, ** )", "( *** )" — is NEVER a chord
        # row. Force it to an instruction line so it isn't swallowed by a lyric that happens
        # to sit 4-45px below it (the bug that silently dropped the upper "( *, ** )"). The
        # "(" requirement keeps bare section headers ("*", "**", "***", which belong to their
        # lyric line) from being promoted into spurious standalone marker rows.
        is_marker = '(' in txt and bool(re.fullmatch(r'[()*#,\s\d.]*[*#][()*#,\s\d.]*', txt.strip()))
        is_instr = is_marker or bool(re.search(r'intro|instru|outro|ending|coda|solo|interlud|bridge|verse|chorus|hook|times|dutro', low))
        if is_instr or not any(4 < (ry - iy) < 45 for ry in row_y):
            f = fmt_instr(txt, vocab)
            if f and re.search(r'\[|Intro|Instru|Outro|\(', f):
                instr.append((sum(1 for ry in row_y if ry < iy), f))
    if warn is not None:                                       # validation flags (for --check)
        for c in chords:
            sp = _split(c['nm'])
            if vocab and c['nm'] not in vocab and sp and not sp[3]:
                warn.append(f"off-vocab chord '{c['nm']}'")
        if rows and not chords: warn.append('lyric rows but ZERO chords')
        lc = sorted({c['nm'] for c in chords if c['conf'] < 0.5})
        if lc: warn.append('low-confidence ' + ','.join(lc))
    title = (ov or {}).get('title', raw['title'])
    note = (ov or {}).get('note', note)
    out = []
    if title: out.append('{title: ' + title + '}')
    if note: out.append('{note: ' + note + '}')
    if out: out.append('')
    def emit_instr(bd):                       # Intro/Instru/Outro get blank lines around them
        for b2, f in instr:
            if b2 == bd:
                if out and out[-1] != '': out.append('')
                out.append(f); out.append('')
    emit_instr(0)
    li = 0
    for row in skel:
        if row.get('blank'):
            out.append('')
        else:
            out.append(NBSP * row['indent'] + (placed[li] if li < len(placed) else row['text']))
            li += 1; emit_instr(li)
    final = []
    for l in out:
        if l == '' and final and final[-1] == '': continue
        final.append(l)
    while final and final[0] == '': final.pop(0)
    while final and final[-1] == '': final.pop()
    return apply_overrides('\n'.join(final), ov)

def apply_overrides(text, ov):
    """Per-song manual corrections that survive every regen (written by the review editor /
    by hand). `rename` fixes a misread chord everywhere in the song; `replace` is an escape
    hatch for any literal fix."""
    if not ov: return text
    for old, new in (ov.get('rename') or {}).items():
        text = re.sub(r'\[' + re.escape(old) + r'\]', '[' + new + ']', text)
    for find, repl in (ov.get('replace') or []):
        text = text.replace(find, repl)
    return text

def main():
    ap = argparse.ArgumentParser(description='Extract chord-sheet images → ChordPro text (with a re-runnable raw cache).')
    ap.add_argument('ids', nargs='*', type=int, help='song ids')
    ap.add_argument('--range', nargs=2, type=int, metavar=('START', 'END'), help='inclusive id range')
    ap.add_argument('--out', default='data/chordpro', help='ChordPro output dir')
    ap.add_argument('--raw', default='data/chordpro-raw', help='cached OCR intermediates (the EXPENSIVE asset)')
    ap.add_argument('--overrides', default='data/chordpro-overrides', help='per-song manual corrections (JSON)')
    ap.add_argument('--cache', default='scripts/.chordpro_cache', help='html+image fetch cache')
    gpu_grp = ap.add_mutually_exclusive_group()
    gpu_grp.add_argument('--gpu', dest='gpu', action='store_true', default=None,
                         help='force CUDA on (default: auto — on whenever CUDA is available)')
    gpu_grp.add_argument('--cpu', dest='gpu', action='store_false',
                         help='force CPU even if CUDA is available')
    ap.add_argument('--device', help="explicit torch device, overrides --gpu/--cpu/auto: 'cuda' / 'cpu' / 'mps'")
    ap.add_argument('--regen', action='store_true', help='rebuild ChordPro from cached raw/ + overrides — NO OCR (fast)')
    ap.add_argument('--check', action='store_true', help='regen AND flag suspect songs (off-vocab / no-chords / low-conf)')
    ap.add_argument('--force', action='store_true', help='re-OCR even if a cached raw/ exists')
    ap.add_argument('--missing', action='store_true', help='extract every song in data/results.json that has no ChordPro yet (for the post-sync one-shot)')
    ap.add_argument('--limit', type=int, metavar='N', help='process at most N ids this run — chunk a big batch. With --missing, each run does the NEXT N un-extracted songs (already-done ids are skipped), so just re-run to continue.')
    ap.add_argument('--print', dest='show', action='store_true', help='also print each result')
    args = ap.parse_args()

    ids = list(args.ids)
    if args.range: ids += list(range(args.range[0], args.range[1] + 1))
    if args.missing:                                  # all results.json ids lacking data/chordpro/<id>.txt
        recs = json.load(open('data/results.json', encoding='utf-8'))
        have = {int(f[:-4]) for f in os.listdir(args.out) if f.endswith('.txt') and f[:-4].isdigit()} if os.path.exists(args.out) else set()
        ids += [r['id'] for r in recs if r['id'] not in have]
        print(f'--missing: {len(ids)} songs without ChordPro yet')
    if args.limit is not None: ids = ids[:max(0, args.limit)]   # chunk: take the first N
    os.makedirs(args.out, exist_ok=True); os.makedirs(args.raw, exist_ok=True)

    def load_ov(sid):
        p = os.path.join(args.overrides, f'{sid}.json')
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else None

    # ---- regen / check: reprocess cached raw, no OCR ----
    if args.regen or args.check:
        if not ids:
            ids = sorted(int(f[:-5]) for f in os.listdir(args.raw) if f.endswith('.json'))
            if args.limit is not None: ids = ids[:max(0, args.limit)]
        t0 = time.time(); flagged = []
        for sid in ids:
            rp = os.path.join(args.raw, f'{sid}.json')
            if not os.path.exists(rp):
                print(f'id={sid:<6} -- no raw cache (run extraction first)'); continue
            raw = json.load(open(rp, encoding='utf-8'))
            warn = [] if args.check else None
            text = assemble(raw, load_ov(sid), warn)
            open(os.path.join(args.out, f'{sid}.txt'), 'w', encoding='utf-8').write(text)
            if args.show: print('\n' + text + '\n')
            if warn: flagged.append((sid, warn)); print(f'id={sid:<6} ⚠ ' + ' | '.join(warn), flush=True)
        print(f'\nregenerated {len(ids)} songs from {args.raw} in {time.time() - t0:.1f}s (no OCR).')
        if args.check:
            rep = os.path.join(args.out, '_flagged.tsv')
            open(rep, 'w', encoding='utf-8').write('\n'.join(f'{s}\t{" | ".join(w)}' for s, w in flagged))
            print(f'{len(flagged)} flagged → {rep}')
        return

    # ---- extract: OCR (expensive) → cache raw/ → assemble ----
    if not ids: ap.error('give song ids or --range START END (or use --regen)')
    os.makedirs(args.cache, exist_ok=True)
    # Resolve the OCR device. EasyOCR's `gpu` arg takes a bool OR a device string
    # ('cuda'/'cpu'/'mps' — 1.7.x passes a non-bool straight through to self.device).
    # NOTE: AMD-GPU-on-Windows via torch-directml was tried and is a DEAD END — EasyOCR's
    # recognizer is an LSTM and torch-directml has no LSTM op (`aten::_thnn_fused_lstm_cell`
    # is unsupported and its CPU fallback is broken), so recognition can't run on DirectML.
    # Don't re-add a `dml` device here. GPU only helps on a real CUDA box (incl. cloud).
    if args.device:                                       # 'cuda' / 'cpu' / 'mps'
        gpu_arg = args.device; print(f'using device: {args.device}', flush=True)
    elif args.gpu is None:                                # auto: use CUDA whenever it's there
        try:
            import torch
            args.gpu = torch.cuda.is_available()
            dev = torch.cuda.get_device_name(0) if args.gpu else None
        except Exception:
            args.gpu = False; dev = None
        print(f"GPU auto-detect: {'on — ' + dev if args.gpu else 'off (no CUDA, using CPU)'}", flush=True)
        gpu_arg = args.gpu
    else:
        gpu_arg = args.gpu

    t0 = time.time(); print(f'loading EasyOCR (device={gpu_arg}) …', flush=True)
    readers = (easyocr.Reader(['en'], gpu=gpu_arg, verbose=False),
               easyocr.Reader(['th', 'en'], gpu=gpu_arg, verbose=False))
    print(f'  ready in {time.time() - t0:.0f}s\n', flush=True)

    ok = miss = fail = cached = 0; spent = 0.0
    for sid in ids:
        t = time.time()
        try:
            rp = os.path.join(args.raw, f'{sid}.json')
            if os.path.exists(rp) and not args.force:
                raw = json.load(open(rp, encoding='utf-8')); cached += 1
            else:
                raw = ocr_raw(sid, readers, args.cache)
                if raw is None:
                    miss += 1; print(f'id={sid:<6} -- no lyrics', flush=True); continue
                json.dump(raw, open(rp, 'w', encoding='utf-8'), ensure_ascii=False)
            text = assemble(raw, load_ov(sid))
            open(os.path.join(args.out, f'{sid}.txt'), 'w', encoding='utf-8').write(text)
            dt = time.time() - t; spent += dt; ok += 1
            print(f'id={sid:<6} OK {dt:4.0f}s -> {args.out}/{sid}.txt', flush=True)
            if args.show: print('\n' + text + '\n')
        except Exception as e:
            fail += 1; print(f'id={sid:<6} FAIL {e}', flush=True)
    if ok:
        ocrd = ok - cached
        print(f'\n{ok} ok ({ocrd} OCR\'d, {cached} from raw cache), {miss} no-lyrics, {fail} failed | '
              f'avg {spent / ok:.1f}s/song | total {time.time() - t0:.0f}s')

if __name__ == '__main__':
    main()
