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
import argparse, difflib, html as H, json, os, re, sys, time
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

# --- HTML lyric line ↔ image OCR row alignment -------------------------------------
# The HTML lyric set (perfect text) and the chord-sheet IMAGE don't always carry the
# same lines: HTML may include verses/repeats the image never draws, the image may show
# a repeated chorus HTML lists once, and OCR can split one wrapped line into two rows.
# Chords are anchored to image rows by y, so to place them on the right HTML line we
# must align the two sequences — not zip them by index (which shifts every line after
# the first mismatch). Pure text-vs-text, no OCR/GPU: reuses the cached Thai OCR rows.
def _norm_lyric(s):
    # OCR mangles Thai combining marks the most; drop them + spaces + markers so the
    # fuzzy ratio reflects the consonant/vowel skeleton both sides share.
    return ''.join(ch for ch in s if not ch.isspace() and not is_comb(ch)
                   and ch not in '*()[]/.,-0123456789')

def _lyric_sim(a, b):
    a, b = _norm_lyric(a), _norm_lyric(b)
    return difflib.SequenceMatcher(None, a, b).ratio() if a and b else 0.0

def align_lyrics(sung, row_texts):
    """Map each HTML lyric line (sung[i]) to the image OCR row it corresponds to (or
    None). Monotonic global alignment. Reduces to the positional 1:1 mapping when the
    counts already match (so balanced songs — incl. ones with poor OCR — are untouched),
    and falls back to positional + a flag when the OCR text is too garbled to align by
    content. Returns (sung_to_row, row_to_sung, info)."""
    n, m = len(sung), len(row_texts)
    pos = ([li if li < m else None for li in range(n)],
           [ri if ri < n else None for ri in range(m)])
    if n == m:
        return pos[0], pos[1], {'mode': 'positional'}
    GAP = -0.35
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    bt = [[''] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1): dp[i][0] = dp[i - 1][0] + GAP; bt[i][0] = 'u'
    for j in range(1, m + 1): dp[0][j] = dp[0][j - 1] + GAP; bt[0][j] = 'l'
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            diag = dp[i - 1][j - 1] + (_lyric_sim(sung[i - 1], row_texts[j - 1]) - 0.5)
            up, lf = dp[i - 1][j] + GAP, dp[i][j - 1] + GAP
            best = max(diag, up, lf); dp[i][j] = best
            bt[i][j] = 'd' if best == diag else ('u' if best == up else 'l')
    s2r, r2s, sims, i, j = [None] * n, [None] * m, [], n, m
    while i > 0 or j > 0:
        mv = bt[i][j]
        if mv == 'd':
            s2r[i - 1] = j - 1; r2s[j - 1] = i - 1
            sims.append(_lyric_sim(sung[i - 1], row_texts[j - 1])); i -= 1; j -= 1
        elif mv == 'u': i -= 1
        else: j -= 1
    avg = sum(sims) / len(sims) if sims else 0.0
    if avg < 0.4:                       # content unreliable → keep positional, flag for review
        return pos[0], pos[1], {'mode': 'lowconf', 'avg': round(avg, 2),
                                'count': (n, m)}
    # RESIDUAL (not auto-fixed): when one wide image row is HTML-wrapped into two lines, this
    # 1:1 align puts all the row's chords on one line and leaves the other plain. A merge+split
    # pass was prototyped but over-fired — it redistributed chords on lines that were already
    # correct (e.g. song 50's "**ฟ้า"), and at 597px the result can't be verified by eye. So it
    # is deliberately NOT applied; these lines are surfaced by --check for targeted review.
    return s2r, r2s, {'mode': 'aligned', 'avg': round(avg, 2),
                      'html_only': sum(1 for x in s2r if x is None),
                      'img_only': sum(1 for x in r2s if x is None)}

# --- chord grammar (theory-aware): maj7/maj BEFORE m so "Ebmaj7" isn't eaten as "Ebm" ---
_QUAL = r'(?:maj13|maj11|maj9|maj7|maj|mmaj7|m7b5|m13|m11|m9|m7|m6|madd9|m|add11|add9|sus2|sus4|sus|dim7|dim|aug|13|11|9|7|6|4|2|\+)'
CHORD_RE = r'[A-Ga-g][#b]?' + _QUAL + r'?(?:/[A-Ga-g][#b]?)?'
CHORD_TOK = re.compile(CHORD_RE)
WEIRD_ROOT = re.compile(r'^(E#|B#|Cb|Fb)')

def _split(c):
    if not c: return None
    c = c.strip().strip('.').replace('|', '').replace('Fem', 'F#m').replace('fem', 'F#m').replace('z', '7').replace('Z', '7')
    m = re.match(r'^([A-Ga-g])([#b]?)(.*)$', c)
    if not m: return None
    root, acc, rest = m.group(1).upper(), m.group(2), m.group(3)
    bass = ''
    if '/' in rest:
        rest, _, b = rest.partition('/')
        mb = re.match(r'([A-Ga-g])([#b]?)', b)
        if mb: bass = '/' + mb.group(1).upper() + mb.group(2)
    qm = re.match(_QUAL, rest)
    qual = qm.group(0) if qm else ''
    if qual == 'maj': qual = ''        # bare "maj" = the major triad (Amaj == A) — normalize, don't flag
    return root, acc, qual, bass

def snap(t):
    s = _split(t)
    return (s[0] + s[1] + s[2] + s[3]) if s else None

def is_chord(t):
    t = t.strip().strip('.').replace(' ', '').replace('|', '').replace('fem', 'f#m').replace('Fem', 'F#m').replace('z', '7').replace('Z', '7')
    return bool(re.fullmatch(CHORD_RE, t)) and not has_thai(t)

def chords_in_box(text, x0, x1):
    t = re.sub(r'[.,:;=_]', '', text.replace('fem', 'f#m').replace('Fem', 'F#m'))
    t = t.replace('z', '7').replace('Z', '7')   # OCR reads the chord "7" as z (F#mz→F#m7, majz→maj7)
    # recover a slash chord whose "/" the OCR read as l / I / |  (e.g. "ElG#" → "E/G#"):
    # otherwise it splits into TWO chords (E + a spurious bass-note G#).
    t = re.sub(r'([A-Ga-g][#b]?)[lIJ|{}]([A-G][#b]?)\b', r'\1/\2', t)
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
        # sorted(): vocab is a set → unsorted iteration made snap_vocab pick a different
        # tie-broken chord per PYTHONHASHSEED (e.g. C#7 vs C#9), so --regen wasn't
        # reproducible build-to-build. Sort for a stable, deterministic choice.
        same = [(v, _split(v)[2]) for v in sorted(vocab)
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
    for v in sorted(vocab):
        q = _split(v)
        if not q: continue
        sc = (q[1] == pp[1]) + 2 * ((q[2] == 'm') == (pp[2] == 'm')) + (q[0] == pp[0])
        if sc > bs: best, bs = v, sc
    return best

def _desharp(t, vocab):
    """OCR reads the '#' glyph as z/s/r ("D#m"→"Dzm"/"Dsm"/"Crm"). 'z' is also OCR for '7'
    (handled in is_chord), and z/s/r are common letters, so only treat one as '#' when the
    result is a chord THIS SONG actually uses (vocab-gated → an English word like "as" can't
    become "A#"). Returns the repaired token, or the original if nothing maps into vocab."""
    if not vocab: return t
    for m in re.finditer(r'[zsrZSR]', t):
        c = t[:m.start()] + '#' + t[m.end():]
        if is_chord(c) and snap(c) in vocab: return c
    return t

INSTR_KW = re.compile(r'^(intro|verse|chorus|prechorus|bridge|outro|ending|coda|solo|interlude|instru(?:mental)?|hook|tag|riff)$', re.I)
INSTR_FIX = [(r'\bdutro\b', 'outro'), (r'\boxtro\b', 'outro'), (r'\bouttro\b', 'outro'), (r'\blnstru\b', 'instru'),
             (r'\binsttu\b', 'instru'), (r'\blntro\b', 'intro'), (r'\bintrd\b', 'intro'), (r'\bintru\b', 'intro')]

def fmt_instr(text, vocab=None):
    t = re.sub(r'[.:;=_]', '', text).strip()
    for pat, rep in INSTR_FIX: t = re.sub(pat, rep, t, flags=re.I)
    # section-repeat marker line — "( * )", "( *, ** )" — often OCRs with ')'→'3', '*'→'#', or a
    # stray letter ("( *, #r ## )"). Rebuild from its star groups so noise can't leak through. The
    # old `fullmatch` bailed on ANY letter (leaking the raw "#r"); now tolerate ≤2 noise letters,
    # gated so a parenthesised chord like "( C#m )" isn't mistaken for a marker (it has a comma or
    # is pure marker-chars). Exact group count on a badly-noised marker may still need an override.
    _inner = re.sub(r'[()\s]', '', t)
    if '(' in t and re.search(r'[*#]', t) and len(re.sub(r'[*#,\d.]', '', _inner)) <= 2 \
            and (',' in t or re.fullmatch(r'[*#,\d.]*', _inner)):
        groups = re.findall(r'[*#]+', t)
        if groups: return '( ' + ', '.join('*' * len(g) for g in groups) + ' )'
    # repeat-count marker "( N Times )": OCR mangles the count (e.g. "'{845483") and the
    # brackets. Rebuild it — keep the count only if a standalone 1-2 digit number survived,
    # else drop the bogus number rather than leak garbage. (The true count, if lost, needs an override.)
    def _fix_times(m):
        n = re.findall(r'(?<!\d)\d{1,2}(?!\d)', m.group(0))
        return f' ( {n[0]} Times )' if n else ' ( Times )'   # leading space: the junk-eater below ate the one before "("
    t = re.sub(r"[(\[]?[^A-Za-z()\[\]]*times\s*[)\]]?", _fix_times, t, flags=re.I)
    # Build a token list, then join with single spaces — canonical, even spacing (the old code
    # echoed raw OCR whitespace, so glued bar runs like "E/D/D/E/E" stayed glued while "Bm / G"
    # kept its spaces). Split on whitespace / '|' / parens but NOT on '/', so a slash chord
    # ("E/G#") survives as one token; standalone '/' is a bar separator; a glued bar RUN
    # ("E/D/D/E/E", 2+ slashes joining bare chords) is split into separate bars below.
    parts, depth = [], 0
    for p in re.split(r'(\s|\||[()\[\]])', t):
        ps = p.strip().strip('{}')      # leading/trailing brace = OCR noise ("{Em"→Em, "E}"→E); an INTERNAL '{' stays for the slash-repair below ("D{F#"→D/F#)
        if not ps: continue
        if ps == '(': depth += 1; parts.append('('); continue
        if ps == ')': depth = max(0, depth - 1); parts.append(')'); continue
        if ps == '/' or ps == '|': parts.append('/'); continue   # a bar line '|' is a '/'
        if depth == 0 and ps == '1':            # a lone '1' is an OCR'd bar '/' (depth-guarded: not a Times count).
            parts.append('/'); continue         # only the digit — NOT 'I'/'l' (they collide with English lyric "I")
        if is_chord(ps):                                       # plain chord, INCL. a slash chord "E/G#" — keep whole
            parts.append('[' + snap_vocab(snap(ps), vocab) + ']'); continue
        # repair OCR chord-glyph misreads, each gated so a word can't be turned into a chord:
        rep = re.sub(r'([A-Ga-g][#b]?)[IJ|{}]([A-Ga-g][#b]?)', r'\1/\2', ps)   # slash '/' read as I/J/|/{/} ("FIA"→F/A, "D{F#"→D/F#)
        if rep != ps and is_chord(rep):
            parts.append('[' + snap_vocab(snap(rep), vocab) + ']'); continue
        sharp = _desharp(ps, vocab)                            # '#' read as z/s/r ("Dzm"→D#m), vocab-gated
        if sharp != ps:
            parts.append('[' + snap_vocab(snap(sharp), vocab) + ']'); continue
        if '/' in ps:                                          # chord(s) glued to bar '/'(s): "E/", "E/D/D", "/0"
            for i, x in enumerate(ps.split('/')):
                if i: parts.append('/')
                if not x: continue
                xd = x.lstrip('0123456789')
                if is_chord(x): parts.append('[' + snap_vocab(snap(x), vocab) + ']')
                elif xd != x and is_chord(xd): parts.append('[' + snap_vocab(snap(xd), vocab) + ']')
                elif re.search(r'[A-Za-z*#]', x): parts.append(x)   # drop letterless junk between bars (OCR'd tab fret numbers "2/8/8/6")
            continue
        psd = ps.lstrip('0123456789')          # "6G"/"1B" — a leading bar '/' OCR'd as a digit
        if psd != ps and is_chord(psd): parts.append('[' + snap_vocab(snap(psd), vocab) + ']')
        elif INSTR_KW.match(ps): parts.append(ps.capitalize())
        elif len(ps) > 1 and not has_thai(ps):
            # merged chord pair whose separator OCR dropped — "DF#" → [D][F#]. Same re-split the
            # lyric-line path does via CHORD_TOK; only fire when chords cover ~all of the token so
            # a stray word can't be turned into chords.
            reps = ps.replace('z', '7').replace('Z', '7').replace('fem', 'f#m').replace('Fem', 'F#m')
            ms = list(CHORD_TOK.finditer(reps))
            if len(ms) > 1 and sum(m.end() - m.start() for m in ms) >= 0.9 * len(reps):
                parts += ['[' + snap_vocab(snap(m.group()), vocab) + ']' for m in ms]
            elif re.search(r'[A-Za-z*#]', ps): parts.append(ps)   # keep word/marker tokens; drop a pure digit/symbol run ("28886€")
        elif len(ps) == 1 and re.fullmatch(r'[^\w/()|*#,.\[\]½-]', ps): pass  # lone OCR-noise symbol (€, @, …) → drop
        elif re.search(r'[A-Za-z*#]', ps): parts.append(ps)   # else: a lone digit / symbol ("0", stray glyph) is OCR noise in an instr row → drop
    s = re.sub(r'\s*\)', ' )', re.sub(r'\(\s*', '( ', ' '.join(parts)))   # tidy parens
    return re.sub(r'\s+', ' ', s).strip()

_INSTR_RESID = re.compile(r'(?i)\b(intro|verse|chorus|prechorus|bridge|outro|ending|coda|solo|interlude|instru(?:mental)?|hook|tag|riff|times)\b')
def _instr_quality(b, vocab):
    """Rank an OCR instr-row candidate so the cross-pass dedup keeps the CLEANEST read, not
    merely the highest-confidence one. The two detector passes often disagree on a single bar —
    one reads the real chord, the other a junk glyph ('�'/'0'/'@') — and the junk read sometimes
    has the higher conf, so conf alone drops a valid chord (empty bar) or leaks noise. Score is
    vocab-aware: penalize junk residue AND chords NOT in the song's vocab, reward in-vocab chords.
    (A plain #-chords count was tried and was WORSE — it rewarded a pass that split one real chord
    into two off-vocab ones, e.g. D#m→D Em or G#m7→"6#m7", since two beats one.)"""
    f = fmt_instr(b['text'], vocab)
    chords = re.findall(r'\[([^\]]+)\]', f)
    nvocab = sum(1 for c in chords if c in vocab)
    noff = sum(1 for c in chords if c not in vocab and '/' not in c) if vocab else 0   # slash chords aren't listed → don't penalize
    resid = re.sub(r'\[[^\]]*\]|\([^)]*\)', '', f)
    resid = re.sub(r'[/\s*#,.\'½-]', '', _INSTR_RESID.sub('', resid))
    return (-(len(resid) + noff), nvocab, b['conf'])

def clean_note(t):
    t = re.sub(r'\s+', ' ', re.sub(r'[|]', '', t)).strip()
    t = re.sub(r'\bv[z2]\b', '½', t, flags=re.I).replace('1/2', '½')
    return t[:1].upper() + t[1:] if t else t

def fetch(sid, cache_dir, retries=3):
    cache = os.path.join(cache_dir, f'{sid}.html')
    html = None
    for attempt in range(retries):                     # retry only when the page looks BLOCKED,
        try:                                           # not when it's a real page that just has no lyrics
            h = requests.get(f'https://chordtabs.in.th/{sid}/', headers=HDR, timeout=20).text
            if 'divlyric' in h:
                html = h; open(cache, 'w', encoding='utf-8').write(h); break
            if len(h) > 2000: break                    # full page, genuinely no lyric image — don't retry
        except Exception:
            pass                                       # network error → retry
        if attempt < retries - 1:                      # short/blocked body or error → back off (rate-limit)
            time.sleep(1.5 * (attempt + 1))
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
    colw = span / max(1, W)                           # avg px/column, for lead/trail extrapolation
    sorted_ch = sorted(rowchords, key=lambda c: c['cx'])
    # Lead-in / pickup chords float BEFORE the first sung word (e.g. "F G" strummed into the
    # downbeat, with the first chord-over-a-word coming later). Require 2+ chords left of the
    # first character: a whole group can't sit above one syllable, so it's genuinely a lead-in.
    # A LONE chord whose center landed left of the word is almost always the word-0 chord nudged
    # left by OCR (or by a "*" section marker eating the left margin) — leave it inline so it
    # still renders above word 0. Without this split, leading chords all clamp to column 0 and
    # the dedup below spreads them onto the FIRST FEW WORDS ("[F]ก็[G]จะ") instead of the margin.
    lead_cut = sum(1 for c in sorted_ch if c['cx'] < Lx0) >= 2
    inserts, trailing, leading = [], [], []
    for c in sorted_ch:
        if lead_cut and c['cx'] < Lx0:
            leading.append(c['nm']); continue
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
    # lead-in / pickup chords (left of the first word): float before the lyric, each in its own
    # column. The trailing NBSP keeps the LAST lead-in off the first syllable, so the first word
    # reads with no chord above it (as printed) — matching the renderer's blank-segment handling.
    if leading:
        s = NBSP.join('[' + nm + ']' for nm in leading) + NBSP + s
    return s

# Versions. PIPE_V = post-processing (assemble) rules — bump on rule changes; `--regen`
# cheaply rebuilds ChordPro from cached raw/. OCR_V = detection — bump only when ocr_raw()
# changes; that's the rare case that needs a (cached-image) re-OCR.
PIPE_V, OCR_V = 2, 1

def ocr_raw(sid, readers, cache_dir, fast=False):
    """EXPENSIVE step (~50s/song): fetch page+image, run OCR. Returns a JSON-able 'raw
    intermediate' (every OCR detection + the HTML facts) — enough to rebuild the ChordPro
    later WITHOUT re-OCR. None if the song has no lyrics.
    fast=True drops the 2nd (s=3 upscale) english pass — ~2x faster, lower chord recall;
    re-run those ids with --force (no --fast) to fill the 2nd pass back in."""
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
    en2 = [] if fast else rnd(ocr_pass(reader_en, base, 3, low_text=0.2, text_threshold=0.4, mag_ratio=1.5, add_margin=0.15))
    return {'id': sid, 'ocr_v': OCR_V, 'title': res['title'], 'vocab': sorted(res['vocab']),
            'skel': res['skel'], 'sung': res['sung'], 'fast': fast,
            'en1': rnd(ocr_pass(reader_en, base, 2, low_text=0.2, text_threshold=0.4, mag_ratio=1.5)),
            'en2': en2,
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
    # Align HTML lines ↔ image rows so chords land on the right line even when the two
    # disagree on which lines exist (the old index-zip shifted everything after a gap).
    row_texts = [' '.join(b['text'] for b in r) for r in rows]
    sung_to_row, _row_to_sung, align_info = align_lyrics(sung, row_texts)
    placed = []
    for li in range(len(sung)):
        ri = sung_to_row[li]
        placed.append(place_line(sung[li], rows[ri], row_chords[ri]) if ri is not None else sung[li])
    note, instr = None, []
    # Instrumental / marker rows from BOTH detector passes (the lyric-line chords already union
    # en1+en2; doing it here too recovers chords only the s=3 pass saw — e.g. a high-conf "Dm / G /"
    # the s=2 pass read as just "1G /"). Dedup cross-pass overlaps (same line, x-spans overlapping),
    # keeping the CLEANEST read (most valid chords, least junk — see _instr_quality), NOT merely the
    # highest-confidence one: the higher-conf pass sometimes read a bar as a junk glyph, dropping a
    # real chord to an empty bar ("F / C / / F") or leaking noise ("/ 0 /").
    nonthai = []
    for b in sorted((b for b in raw['en1'] + raw['en2'] if not has_thai(b['text']) and b['text'].strip()),
                    key=lambda b: _instr_quality(b, vocab), reverse=True):
        if not any(abs(b['yc'] - o['yc']) < 10 and
                   min(b['x1'], o['x1']) - max(b['x0'], o['x0']) > 0.4 * min(b['x1'] - b['x0'], o['x1'] - o['x0'])
                   for o in nonthai):
            nonthai.append(b)
    nonthai.sort(key=lambda b: b['yc'])
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
        _mi = re.sub(r'[()\s]', '', txt)        # tolerate ≤2 OCR-noise letters ("#r"), same as fmt_instr's marker rule
        is_marker = '(' in txt and bool(re.search(r'[*#]', txt)) and len(re.sub(r'[*#,\d.]', '', _mi)) <= 2 \
            and (',' in txt or bool(re.fullmatch(r'[*#,\d.]*', _mi)))
        is_instr = is_marker or bool(re.search(r'intro|instru|outro|ending|coda|solo|interlud|bridge|verse|chorus|hook|times|dutro', low))
        if is_instr or not any(4 < (ry - iy) < 45 for ry in row_y):
            f = fmt_instr(txt, vocab)
            if f and re.search(r'\[|Intro|Instru|Outro|\(', f):
                instr.append((sum(1 for ry in row_y if ry < iy), f))
    if warn is not None:                                       # validation flags (for --check)
        # off-vocab: the page's chord-diagram list is often a PARTIAL subset (it omits common
        # chords), so "not in vocab" ALONE flags hundreds of perfectly-real reads (C, G, C#m…).
        # Trust repetition — a clean chord read ≥2× at decent confidence is real. Surface an
        # off-vocab chord only when it's ALSO weak (a one-off OR low-confidence): the true misreads.
        ov_stats = {}
        for c in chords:
            sp = _split(c['nm'])
            if vocab and c['nm'] not in vocab and sp and not sp[3]:
                st = ov_stats.setdefault(c['nm'], [0, 0.0])
                st[0] += 1; st[1] = max(st[1], c['conf'])
        for nm in sorted(ov_stats):
            n, mc = ov_stats[nm]
            if n >= 2 and mc >= 0.5: continue                  # repeated + confident → real; page vocab just omitted it
            warn.append(f"off-vocab chord '{nm}'" + (f' (×{n})' if n > 1 else ''))
        if rows and not chords: warn.append('lyric rows but ZERO chords')
        lc = sorted({c['nm'] for c in chords if c['conf'] < 0.5})
        if lc: warn.append('low-confidence ' + ','.join(lc))
        if align_info.get('mode') == 'aligned':       # HTML↔image lyric-set mismatch (extra/missing/dup)
            if align_info['html_only']: warn.append(f"{align_info['html_only']} HTML line(s) not drawn in image")
            if align_info['img_only']:  warn.append(f"{align_info['img_only']} image row(s) absent from HTML")
        elif align_info.get('mode') == 'lowconf':
            warn.append(f"line-count {align_info['count'][0]}≠{align_info['count'][1]} but OCR too garbled to realign (avg {align_info['avg']}) — check manually")
        # Instr/Intro/Outro line that still has non-chord, non-separator, non-label RESIDUE after
        # fmt_instr — i.e. OCR junk that leaked through (stray digits like "0", garbled markers).
        # Surfaces exactly the rows a human/VLM should eyeball; clean instr lines never flag.
        _kw = re.compile(r'(?i)\b(intro|verse|chorus|prechorus|bridge|outro|ending|coda|solo|interlude|instru(?:mental)?|hook|tag|riff|times)\b')
        for _, f in instr:
            f = apply_overrides(f, ov)                             # respect a per-song fix so an overridden line stops flagging
            resid = re.sub(r'\[[^\]]*\]|\([^)]*\)', '', f)         # drop [chords] and ( … ) groups
            resid = re.sub(r'[/\s*#,.\'½-]', '', _kw.sub('', resid))   # drop separators / markers / labels
            if resid: warn.append(f'instr leftover "{resid}" in: {f.strip()}')
            # A section line (Intro/Instru/Outro…) with ZERO chords usually means OCR dropped the
            # bars (e.g. "Instru / C / F / ( 3 Times )" mis-read to just "Instru ( Times )"). The
            # data isn't in the raw, so --regen can't recover it → flag for re-OCR (--force) or an
            # override. (Bare markers "( *, ** )" don't match the keyword, so they don't flag.)
            elif re.match(r'(?i)(intro|verse|chorus|prechorus|bridge|outro|ending|coda|solo|interlude|instru(?:mental)?|hook|tag|riff)\b', f) and '[' not in f:
                warn.append(f'instr line lost its chords (OCR miss): {f.strip()}')
    title = (ov or {}).get('title', raw['title'])
    note = (ov or {}).get('note', note)
    out = []
    if title: out.append('{title: ' + title + '}')
    if note: out.append('{note: ' + note + '}')
    if out: out.append('')
    def emit_instr(bd):                       # Intro/Instru/Outro: blank line around the BLOCK, but
        fs = [f for b2, f in instr if b2 == bd]   # consecutive CHORD rows of one block stay tight
        if not fs: return                          # (no blank between an Intro's own 2-3 rows). A
        if out and out[-1] != '': out.append('')   # standalone "( *, ** )" repeat marker keeps a
        prev_marker = None                          # blank on both sides so it isn't glued to a block.
        for f in fs:
            marker = f.lstrip().startswith('(')
            if prev_marker is not None and (marker or prev_marker) and out[-1] != '':
                out.append('')
            out.append(f)
            prev_marker = marker
        out.append('')
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

def warn_th(w):
    """Human-readable THAI phrasing of an English --check warning. Shipped per-song in
    songs.bin (column 3 of _flagged.tsv) and shown in-app to the owner only, so the person
    reviewing the catalogue sees *what* is wrong in their own language without reading the
    code. Unknown shapes fall back to the raw English string."""
    m = re.match(r"off-vocab chord '(.+?)'( \(×\d+\))?$", w)   # tolerate the optional " (×N)" occurrence-count suffix
    if m: return f"คอร์ด {m.group(1)} อาจอ่านผิด (ไม่อยู่ในชุดคอร์ดของเพลง){m.group(2) or ''}"
    m = re.match(r"low-confidence (.+)$", w)
    if m: return f"คอร์ด {m.group(1)} ความมั่นใจต่ำ อาจอ่านผิด"
    if w == 'lyric rows but ZERO chords': return "มีเนื้อเพลงแต่อ่านคอร์ดไม่ได้เลย"
    m = re.match(r"(\d+) HTML line\(s\) not drawn in image$", w)
    if m: return f"เนื้อเพลง {m.group(1)} บรรทัดไม่ปรากฏในรูป (อาจเป็นท่อนซ้ำ หรือคอร์ดวางไม่ครบ)"
    m = re.match(r"(\d+) image row\(s\) absent from HTML$", w)
    if m: return f"มีบรรทัดในรูป {m.group(1)} แถวที่ไม่มีในเนื้อเพลง (อาจมีเนื้อ/คอร์ดเกิน)"
    m = re.match(r"line-count (\d+)≠(\d+) but OCR too garbled", w)
    if m: return f"จำนวนบรรทัดไม่ตรง ({m.group(1)}≠{m.group(2)}) และรูปเบลอเกินกว่าจะจับคู่อัตโนมัติ — ต้องตรวจมือ"
    m = re.match(r'instr leftover "(.+)" in:', w)
    if m:
        snip = m.group(1)
        if len(snip) > 30: snip = snip[:30] + '…'
        return f'มีข้อความแปลกปลอม "{snip}" หลุดเข้าท่อนดนตรี (Intro/Instru/Outro)'
    if w.startswith('instr line lost its chords'):
        return "ท่อนดนตรีอ่านคอร์ดไม่ออก (OCR พลาด) — ต้องกู้จากรูป"
    return w


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
    # Windows consoles default to cp1252; printing Thai lyrics, '⚠', or '≠' raised
    # UnicodeEncodeError and aborted the run mid-batch. Force utf-8 (replace on failure)
    # so progress prints can never crash the pipeline regardless of console codepage.
    for _s in (sys.stdout, sys.stderr):
        try: _s.reconfigure(encoding='utf-8', errors='replace')
        except Exception: pass
    ap = argparse.ArgumentParser(description='Extract chord-sheet images → ChordPro text (with a re-runnable raw cache).')
    ap.add_argument('ids', nargs='*', type=int, help='song ids')
    ap.add_argument('--range', nargs=2, type=int, metavar=('START', 'END'), help='inclusive id range')
    ap.add_argument('--out', default='data/chordpro', help='ChordPro output dir')
    ap.add_argument('--raw', default='data/chordpro-raw', help='cached OCR intermediates (the EXPENSIVE asset)')
    ap.add_argument('--overrides', default='data/chordpro-overrides', help='per-song manual corrections (JSON)')
    ap.add_argument('--cache', default='scripts/.chordpro_cache', help='html+image fetch cache')
    ap.add_argument('--vlm-dir', dest='vlm_dir', default='data/chordpro-vlm', help='verbatim VLM-extracted ChordPro (scripts/vlm_chordpro.py). Preferred over OCR assembly during regen so a VLM fix survives every rule rebuild and is never re-flagged.')
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
    ap.add_argument('--ids-file', dest='ids_file', help='read song ids from a file (one per line) — used by the parallel backfill launcher (scripts/backfill.py)')
    ap.add_argument('--limit', type=int, metavar='N', help='process at most N ids this run — chunk a big batch. With --missing, each run does the NEXT N un-extracted songs (already-done ids are skipped), so just re-run to continue.')
    ap.add_argument('--fast', action='store_true', help='drop the 2nd (s=3) detector pass — ~2x faster OCR, slightly lower chord recall. Re-run flagged ids with --force (no --fast) for full quality.')
    ap.add_argument('--print', dest='show', action='store_true', help='also print each result')
    args = ap.parse_args()

    ids = list(args.ids)
    if args.range: ids += list(range(args.range[0], args.range[1] + 1))
    if args.ids_file:                                 # one id per line (parallel backfill shards)
        with open(args.ids_file, encoding='utf-8') as fh:
            ids += [int(x) for x in fh.read().split() if x.strip().lstrip('-').isdigit()]
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

    def load_vlm(sid):
        p = os.path.join(args.vlm_dir, f'{sid}.txt')
        return open(p, encoding='utf-8').read() if os.path.exists(p) else None

    # ---- regen / check: reprocess cached raw, no OCR ----
    if args.regen or args.check:
        if not ids:
            ids = sorted(int(f[:-5]) for f in os.listdir(args.raw) if f.endswith('.json'))
            if args.limit is not None: ids = ids[:max(0, args.limit)]
        t0 = time.time(); flagged = []
        for sid in ids:
            # A VLM re-extraction (scripts/vlm_chordpro.py) wins outright: use it verbatim,
            # skip OCR assembly entirely, and never flag it. apply_overrides still stacks so a
            # tiny manual patch can ride on top. This is what makes a VLM fix durable — a later
            # rule-fix `chordpro:build` regenerates every song but leaves these untouched.
            vlm = load_vlm(sid)
            if vlm is not None:
                text = apply_overrides(vlm, load_ov(sid))
                open(os.path.join(args.out, f'{sid}.txt'), 'w', encoding='utf-8').write(text)
                if args.show: print('\n' + text + '\n')
                continue
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
            # cols: id \t english reasons (dev/tooling) \t thai reasons (shipped to owner UI).
            # vlm_chordpro.py + build-data.mjs both split on the FIRST tab, so the extra column
            # is harmless to existing readers.
            def th_join(w):                                   # dedup identical Thai phrasings,
                seen, out = set(), []                          # keep order — collapses e.g. the
                for x in w:                                    # same "off-vocab C#m" repeated 11×
                    t = warn_th(x)
                    if t not in seen: seen.add(t); out.append(t)
                return ' | '.join(out)
            rows = [f'{s}\t{" | ".join(w)}\t{th_join(w)}' for s, w in flagged]
            open(rep, 'w', encoding='utf-8').write('\n'.join(rows))
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
                raw = ocr_raw(sid, readers, args.cache, fast=args.fast)
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
