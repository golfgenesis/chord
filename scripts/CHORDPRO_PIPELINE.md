# ChordPro pipeline — status & handoff

Goal: replace the chord-sheet **images** with **ChordPro text** (chords inline above the
right Thai word) so the client renders text + transposes, no images. Source:
`chordtabs.in.th/{id}/` (70,126 songs).

## How it works (two stages — the important part)

`scripts/extract_chordpro.py` is split so a late-found bug never means re-OCRing 70k:

- **`ocr_raw(id)` — EXPENSIVE (~45–55s/song CPU).** Fetch page + image, run OCR, return a
  JSON-able *raw intermediate* (every OCR detection + the HTML facts). Cached to
  `data/chordpro-raw/<id>.json`.
- **`assemble(raw, overrides)` — CHEAP (~ms).** All the *rules* live here (chord grammar,
  vocab repair, placement, spacing, instruction rows). Re-runnable over every cached raw.

So: a **rule bug → fix code + `--regen`** rebuilds all songs in minutes (8 songs ≈ 0.7s);
a **one-off misread → an override + `--regen`** (seconds); only a **detection change** needs
re-OCR (and even then from the cached image, no re-fetch).

### npm scripts (package.json)

    npm run chordpro -- 48 100 2289     # OCR-extract these ids (or `-- --range 1 200`)
    npm run chordpro:next               # ⭐ BATCH: OCR the next 50 un-extracted songs (--missing
                                        #    --limit 50) + rebuild songs.bin. Re-run to continue;
                                        #    already-done ids are skipped. Override N: `-- --limit 100`.
    npm run chordpro:backfill           # ⭐ PARALLEL BACKFILL (70k): fan OCR across N worker
                                        #    processes (default 8) with a live ETA, then rebuild
                                        #    songs.bin. Resumable. `-- --fast` ≈2x (lower recall);
                                        #    `-- --workers 6` / `-- --limit 200` to tune/test.
    npm run chordpro:check              # regen ALL from cached raw + flag suspect songs →
                                        #    data/chordpro/_flagged.tsv  (NO OCR, NO ship)
    npm run chordpro:build              # ⭐ ONE-SHOT: regen ALL from cached raw + rebuild songs.bin
                                        #    (ship it). Run this after fixing a RULE bug (affects all).
    npm run chordpro:fix -- 19 26       # ⭐ PER-SONG: regen JUST these ids (applies their
                                        #    overrides) + rebuild songs.bin. No ids = all. Use after
                                        #    editing data/chordpro-overrides/<id>.json.
    npm run chordpro:regen -- 19        # regen song(s) only, NO rebuild (quick text preview).
                                        #    No ids = regen ALL. Follow with `npm run data` to ship.
    npm run sync:chordpro               # ⭐ FULL ONE-SHOT: scrape new songs → OCR the new ones
                                        #    (--missing) → rebuild songs.bin

### Fix workflow (find → fix → ship)

    1. npm run chordpro:check                 # find broken songs → _flagged.tsv (categorized)
    2a. edit a RULE in extract_chordpro.py  → npm run chordpro:build     # pattern bug, fixes all 70k
    2b. edit data/chordpro-overrides/<id>.json → npm run chordpro:fix -- <id>   # one-off, per song
    3. npm run dev   (then Ctrl+Shift+R — the service worker caches the old songs.bin)

Raw OCR is cached, so `--regen`/fix/build re-run only the cheap assembly — per-song is instant;
regenerating all 70k is ~1-2h, so prefer `chordpro:fix -- <id>` while iterating on one song. No
daemon/service is needed; the only long job is the initial OCR backfill (`chordpro:backfill`).

Note: `npm run … -- <args>` appends args to the END of the script string, so it only works on
single-command scripts (`chordpro`, `chordpro:check`). To regen specific ids WITHOUT shipping
(e.g. after fixing one override), call python directly: `py -3.11 scripts/extract_chordpro.py --regen 7 11`.
`npm run data` / `dev` / `build:full` already bundle ChordPro into the payload automatically.

### Direct (python)

    py -3.11 scripts/extract_chordpro.py 48 100 2289      # specific ids  (needs py3.11 +
    py -3.11 scripts/extract_chordpro.py --range 1 200    # an id range    easyocr torch pythainlp)
    py -3.11 scripts/extract_chordpro.py --regen          # rebuild ALL from cached raw, NO OCR
    py -3.11 scripts/extract_chordpro.py --missing        # only results.json ids without ChordPro
    py -3.11 scripts/extract_chordpro.py --check          # regen + flag suspects → _flagged.tsv
    py -3.11 scripts/extract_chordpro.py 48 --gpu --print  # CUDA (10–20× faster) + show

Output → `data/chordpro/<id>.txt`. HTML+image cache → `scripts/.chordpro_cache/`.

### Per-song manual corrections (survive every regen)

`data/chordpro-overrides/<id>.json` (committed; see its README):

    { "rename": {"E#m":"C#m"}, "replace": [["Outro / [B7]","Outro / [B]"]],
      "title":"…", "note":"…" }

## Key techniques (why each exists)

- **Lyrics + structure from HTML**, not OCR: the 2nd `#divlyric` holds perfect Thai text +
  blank-line spacing + indentation (`&nbsp;` count) + `* / **` markers. Zero OCR error there.
- **Chord vocabulary from the page**: the chord-diagram `<img>` links list the song's exact
  chord set (`C-sharp-m.webp`→C#m) — used to repair OCR misreads. It can be a *partial*
  superset (some songs omit common E / G/B), so repair only *completes* a less-specific
  reading and otherwise *trusts* it.
- **Watermark removal**: grayscale + threshold(<135) → clean black-on-white; also kills the
  phantom-lyric rows that broke row↔line alignment.
- **English-only EasyOCR reader for chords**: a `['th','en']` reader corrupts chord glyphs
  (C#m→'e#m', G#m→'eem'); `['en']` reads them right. `['th','en']` is used only to locate
  the Thai lyric boxes (for row grouping + alignment).
- **OCR repairs**: `z→7` (F#m7→"F#mz"), slash misread l/I/|→`/` ("ElG#"→E/G#), `fem`→F#m,
  merged chord boxes re-split, dropped maj7/7 completed from vocab.
- **Placement**: each chord → the real Thai WORD it floats above (pythainlp word boundaries +
  zero-width Thai marks), via a **piecewise** pixel→column map built from the OCR sub-boxes
  (far better than uniform on long lines with phrase gaps). Padded so labels never collide
  (`_lblcols ≈ 1.5×name length`). Chords past the last word float as trailing chords.
- **HTML↔image line alignment** (`align_lyrics`): the HTML lyric set and the chord-sheet IMAGE
  don't always carry the same lines — HTML may include verses/repeats the image never draws,
  the image may show a repeated chorus HTML lists once, and OCR can split one wrapped line into
  two rows. Chords are anchored to image rows by y, so each HTML line is **fuzzy-aligned**
  (monotonic global align on the cached Thai OCR rows) to the image row it matches, then chords
  are placed on that line. The old code zipped HTML line `i` ↔ image row `i` by index, so any
  count/order mismatch silently shifted every line after it (this was the main "ตำแหน่งไม่ตรง"
  cause). Reduces to the 1:1 positional map when counts match; falls back to positional + a
  `--check` flag when OCR is too garbled to align (avg sim < 0.4). ~23% of songs had a
  line-count mismatch. **No OCR/GPU — pure text-vs-text on data already cached.**
- **Determinism**: `snap_vocab` now iterates `sorted(vocab)` (was a `set` → tie-broken chords
  like C#7 vs C#9 flipped per `PYTHONHASHSEED`, so `--regen` wasn't reproducible build-to-build).
  `main()` also forces utf-8 stdout so progress prints can't crash on a Windows cp1252 console.
- **Instr/Intro/Outro rows** (`fmt_instr`): tokenized WITHOUT splitting on `/` (so a slash chord
  `E/G#` stays one `[E/G#]`; a chord glued to a bar — `E/`, `E/D/D` — is de-glued), then joined
  with canonical ` / ` spacing (the old code echoed raw OCR whitespace → glued `E/D/D/E/E` vs
  spaced `Bm / G`). A lone digit `1` → `/` (OCR reads the bar `/` as `1`; digit only, depth-guarded
  so a `( 1 Times )` count is safe — NOT `I`/`l`, which collide with English lyric "I"). Chord
  grammar `_QUAL` covers 13/11 extensions so `Eb13` is recognized.

## Finding broken songs at scale — `npm run chordpro:check`

The scalable QA answer (no OCR/GPU; all 70k in minutes). `--check` regenerates from cached raw and
writes `data/chordpro/_flagged.tsv` — every suspect song + a categorized reason:
- `N HTML line(s) not drawn in image` / `N image row(s) absent from HTML` — lyric-set mismatch (the
  HTML↔image alignment residue; chords may still be off on these).
- `line-count A≠B but OCR too garbled to realign` — alignment fell back to positional; eyeball it.
- `instr leftover "X" in: …` — an Intro/Instru/Outro line still carrying non-chord junk after
  `fmt_instr` (stray digits, garbled chords like `Dzm`=D#m or `AbJc`=Ab/C, English-lyric-as-instr).
- `off-vocab chord` / `low-confidence` — chord-name suspects.

**Workflow:** run check → sort `_flagged.tsv` by category → fix the biggest category's *rule* in
`fmt_instr`/grammar/detection → `--regen` ALL (fixes every song with that pattern at once) → repeat.
Residue a regex can't judge (exact position on dense lines, wrapped lines) → manual override or a
vision-LLM pass on the **flagged subset only** — never the whole 70k.

## App integration

- Renderer `src/components/ChordSheet.tsx` (note banner, chord-only Intro/Instru rows, blanks,
  indentation, transpose). Parser `src/lib/chordpro.ts`.
- `src/components/Fullscreen.tsx`: text mode whenever `getSampleChordpro(id)` returns a sheet.
  **Owner image toggle** (header 📷) — only emails `blackpearl_golf@hotmail.com` /
  `blackpearlgolf@gmail.com` can flip a song back to the original image; everyone else always
  gets the OCR text. localStorage `owner-image-mode`.
- **ChordPro ships in the payload now.** `scripts/build-data.mjs` reads `data/chordpro/<id>.txt`
  and bundles each as a `cp` field on the song record in `public/songs.bin`. The client decodes
  it (`Song.cp` in `src/types.ts`) and `Fullscreen` uses `getSampleChordpro(id) ?? song.cp` — so
  a hand-authored override wins, else the pipeline's text. `src/lib/sampleChordpro.ts` now holds
  ONLY **song 11** (hand-authored gold); every other converted song flows through the payload.
- Fonts (index.html): lyrics **Noto Sans Thai**, chords **Inter** bold, one size `CHORD_EM`.

## Accuracy today (fully automatic)

- Chord **names**: high — vocab repair + z/slash/fem fixes + maj7 handling.
- **Structure**: faithful — intro/instru/outro, blank lines, section indentation, markers.
- **Positions**: good on normal lines. Two separate issues, one fixed:
  - ✅ **Whole-line misalignment (FIXED)** — when HTML and the image disagreed on which lines
    exist, chords landed on the wrong lines from the first mismatch down. Now handled by
    `align_lyrics` (see Key techniques). ~23% of songs were affected. `--check` now flags the
    residue ("N HTML line(s) not drawn in image" / "N image row(s) absent from HTML" / "OCR too
    garbled to realign").
  - ⚠ **Residual: wrapped lines** — when the image draws one wide row that HTML splits into two
    lines, the 1:1 align puts all that row's chords on one HTML line and leaves the other plain
    (it doesn't yet split a row's chords across the two by x). Smaller than the old global shift.
  - ⚠ **Dense "cliché"/cycling lines** (song 7 `F#m F#mmaj7 F#m7 F#m6`, `D Bm F#m E`×) still
    drift: OCR gives word/segment boxes, not per-character x, and packs a fast run into one wide
    box. Improve via better sub-segment anchoring, a per-glyph-x chord detector, or overrides.

## Throughput / backfill (70k)

- ~45-52s/song CPU → single CPU ≈ 36-42 days. **Use `npm run chordpro:backfill`** (scripts/backfill.py):
  N pinned worker processes + live ETA + rebuild. Realistically a few days on a 6c/12t box;
  `--fast` (drop the s=3 pass) roughly halves it for some recall loss. Resumable.
- **GPU is NOT an option on this dev box** — the card is an AMD RX 6600 XT (no CUDA), and EasyOCR's
  LSTM recognizer can't run on DirectML (proven dead-end — see the comment in `extract_chordpro.py`).
  CUDA EasyOCR would be ≈2-4 days, but that needs an NVIDIA card / cloud. RapidOCR+onnxruntime-directml
  is the only AMD-on-Windows GPU path and would be an engine rewrite.
- Don't re-fetch 70k images (site rate-limits → 97-byte block pages): OCR the **local images**
  (already in `images/` + R2) and capture HTML lyric+vocab by **augmenting `scrape.py`**
  (it already visits each page). `fetch()` now retries-with-backoff on blocked pages so the
  parallel backfill survives transient rate-limiting; heavy parallelism still warrants the local-HTML mode.
- Storage: raw ≈18KB/song (~1.3GB / ~300MB gzip) → **Cloudflare R2** (for 70k consolidate to
  one `chordpro-raw.ndjson.gz` or SQLite, not 70k files). overrides → git. chordpro → a
  `chordpro` field in songs.bin (~20–35MB gzip) → R2/Pages.

## What's left / next
1. Dense-line position precision (the open limitation above).
2. ✅ Parallel CPU backfill (`scripts/backfill.py`) + optional `--fast` (drop S=3). GPU is out on this
   box (AMD); a CUDA/cloud run or a RapidOCR+DirectML rewrite is the only way to go faster than CPU-parallel.
3. Read-local-images / local-HTML mode in `extract_chordpro.py` (skip fetch for backfill — biggest
   remaining win for a clean 70k run without rate-limit risk).
4. Consolidate raw → NDJSON/SQLite + upload to R2.
5. Add the `chordpro` field to `scripts/build-data.mjs` / songs.bin; retire `chordOCR.ts` +
   `ChordOverlay.tsx` once coverage is high.
6. (Optional) review editor that writes `overrides/` by comparing render ↔ original image.
