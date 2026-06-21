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
    npm run chordpro:refresh            # ⭐ REFRESH: rebuild ChordPro for ALL converted songs
                                        #    from cached raw — NO OCR (fast). After fixing a rule
                                        #    bug (wrong chord / word / overlap), run this.
    npm run chordpro:refresh -- 7 11    #    …or just specific ids
    npm run chordpro:check              # refresh + flag suspect songs → data/chordpro/_flagged.tsv
    npm run chordpro:build              # ⭐ ONE-SHOT: refresh ALL + rebuild songs.bin (ship it)
    npm run sync:chordpro               # ⭐ FULL ONE-SHOT: scrape new songs → OCR the new ones
                                        #    (--missing) → rebuild songs.bin

Note: `npm run … -- <args>` appends args to the END of the script string, so pass ids only to
single-command scripts (`chordpro`, `chordpro:refresh`, `chordpro:check`). For a targeted ship,
run `chordpro:refresh -- <ids>` then `npm run data`. `npm run data` / `dev` / `build:full`
already bundle ChordPro into the payload automatically.

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
- **Positions**: good on normal lines; **KNOWN LIMITATION** = dense "cliché"/cycling lines
  (e.g. song 7: `F#m F#mmaj7 F#m7 F#m6` or `D Bm F#m E` repeated over short syllables) still
  drift vs the original. OCR gives word/segment boxes, not per-character pixel positions, and
  packs a fast run into one wide box — so exact per-syllable placement isn't recoverable from
  the data alone. Improve via: better sub-segment anchoring, a chord-glyph detector that
  returns per-glyph x, or per-song overrides.

## Throughput / backfill (70k)

- ~52s/song CPU → single CPU ≈ 42 days; ×8 parallel ≈ 5 days; **single GPU ≈ 2–4 days**;
  GPU+batch+2-pass ≈ ~1 day.
- Don't re-fetch 70k images (site rate-limits → 97-byte block pages): OCR the **local images**
  (already in `images/` + R2) and capture HTML lyric+vocab by **augmenting `scrape.py`**
  (it already visits each page).
- Storage: raw ≈18KB/song (~1.3GB / ~300MB gzip) → **Cloudflare R2** (for 70k consolidate to
  one `chordpro-raw.ndjson.gz` or SQLite, not 70k files). overrides → git. chordpro → a
  `chordpro` field in songs.bin (~20–35MB gzip) → R2/Pages.

## What's left / next
1. Dense-line position precision (the open limitation above).
2. `--gpu` + batched readtext + maybe drop the S=3 pass for the real backfill.
3. Read-local-images mode in `extract_chordpro.py` (skip fetch for backfill).
4. Consolidate raw → NDJSON/SQLite + upload to R2.
5. Add the `chordpro` field to `scripts/build-data.mjs` / songs.bin; retire `chordOCR.ts` +
   `ChordOverlay.tsx` once coverage is high.
6. (Optional) review editor that writes `overrides/` by comparing render ↔ original image.
