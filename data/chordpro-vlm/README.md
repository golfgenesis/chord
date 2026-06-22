# data/chordpro-vlm/

Verbatim ChordPro produced by a **vision model** (`scripts/vlm_chordpro.py`, run through
`claude -p` — the Claude Code subscription, not the metered API). Each `<id>.txt` is the
final, hand-quality text for a song the free EasyOCR pipeline couldn't get right.

**Why this folder exists / how it wins:** `extract_chordpro.py --regen` (i.e. `chordpro:build`)
prefers `chordpro-vlm/<id>.txt` over OCR assembly and never re-flags it. So a VLM fix here is
**durable** — a later rule-fix rebuild regenerates every other song but leaves these untouched.
`data/chordpro/<id>.txt` is just the build artifact (what `build-data.mjs` bundles); this is the
source of truth. A per-song JSON in `data/chordpro-overrides/` still stacks on top (rename/replace).

**When to use it** — only for the minority `chordpro:check` flags as genuinely broken:
the page HTML had no lyrics (chords jam into Intru rows, e.g. song 15), the scan is garbled
past realignment, etc. Valid-but-`off-vocab` chords and bare `low-confidence` are usually fine —
don't burn VLM runs on those.

```bash
npm run chordpro:vlm -- 15           # one song
npm run chordpro:vlm -- --flagged    # every id in data/chordpro/_flagged.tsv
npm run chordpro:vlm -- 15 --dry-run # inspect the prompt, no model call
# then:
npm run data                         # rebuild songs.bin   (or `npm run chordpro:build`)
```

Files here are committed — they're real corrected content, not a cache.
