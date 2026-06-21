# Per-song chord corrections (committed, versioned)

Each `<id>.json` is a manual fix layer applied on top of the OCR result by
`scripts/extract_chordpro.py` during `--regen`. It survives every regeneration,
so rule changes never wipe a hand-correction.

Schema (all keys optional):
```json
{
  "rename":  { "E#m": "C#m" },                 // fix a misread chord EVERYWHERE in this song
  "replace": [ ["Outro / [B7]", "Outro / [B]"] ], // literal text replacement (escape hatch)
  "title":   "...",                            // override the detected title
  "note":    "Tune Down 1/2 tone to Eb"        // override the {note} banner
}
```
Find songs that need a correction with:  `py -3.11 scripts/extract_chordpro.py --check`
