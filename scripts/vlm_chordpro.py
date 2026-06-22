#!/usr/bin/env python3
"""vlm_chordpro.py — re-extract HARD songs with a vision model via `claude -p`.

The EasyOCR pipeline (extract_chordpro.py) is free and handles most of the 70k catalogue,
but a minority of songs defeat it: the page HTML carries no lyric text (so the chords get
jammed into the Intru rows — e.g. song 15), the scan is garbled past realignment, etc.
`chordpro:check` flags exactly these into data/chordpro/_flagged.tsv.

This tool sends the cached chord-sheet IMAGE to a vision LLM and asks it to transcribe the
sheet straight into our house ChordPro format. It runs through the Claude Code CLI
(`claude -p`), so it bills against the *subscription*, NOT the metered API — no API key, no
per-token charge. (That also means it's subject to the subscription's usage limits, so do
the flagged subset, not all 70k.)

Why `claude -p` and not raw bytes: you CANNOT pipe a PNG into `claude -p` (that sends a
non-text request → HTTP 400). Instead we name the image's path in the prompt and let the
agent's own Read tool open it (`--allowedTools Read`).

Durability: output is written to data/chordpro-vlm/<id>.txt (the durable source of truth)
AND mirrored to data/chordpro/<id>.txt (what build-data.mjs bundles). extract_chordpro.py's
--regen prefers the chordpro-vlm/ copy, so a later rule-fix rebuild never clobbers it.

    py -3.11 scripts/vlm_chordpro.py 15            # one song
    py -3.11 scripts/vlm_chordpro.py --flagged     # every id in _flagged.tsv
    py -3.11 scripts/vlm_chordpro.py 15 --dry-run  # print the prompt, don't call the model

After a run: `npm run data` (rebuild songs.bin) then Ctrl+Shift+R in the browser. Or just
`npm run chordpro:build` to regen everything (VLM songs are preserved) + rebuild.
"""
import argparse, json, os, re, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _u8():
    for s in (sys.stdout, sys.stderr):
        try: s.reconfigure(encoding='utf-8', errors='replace')
        except Exception: pass


def read_flagged(out_dir):
    p = os.path.join(out_dir, '_flagged.tsv')
    if not os.path.exists(p):
        return []
    ids = []
    for line in open(p, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        head = line.split('\t', 1)[0]
        if head.lstrip('-').isdigit():
            ids.append(int(head))
    return ids


def build_prompt(sid, raw, img_abs, ref_text):
    """Assemble the text prompt. The image is referenced by PATH (the agent reads it with its
    Read tool); the lyrics, when the page HTML had them, are pasted in as ground truth so the
    model never has to OCR Thai — it only places chords."""
    title = (raw.get('title') or '').strip()
    sung = [s for s in (raw.get('sung') or []) if s and s.strip()]
    vocab = ', '.join(raw.get('vocab') or [])

    P = []
    P.append("You are transcribing a Thai song chord sheet IMAGE into the exact ChordPro text "
              "format this app uses. Output ONLY the ChordPro text — no code fences, no commentary, "
              "no explanation before or after.")
    P.append(f"\nRead this image file with your Read tool, then transcribe it:\n{img_abs}")

    P.append("\nFORMAT RULES (follow EXACTLY):")
    P.append("- First line is the title: {title: " + (title or "<title here>") + "}")
    P.append("- Put every chord in square brackets [Chord] IMMEDIATELY before the syllable it sits "
             "above in the image, with NO space between the bracket and that syllable "
             "(e.g. \"[Bm]คนเรา\", \"problem I [G]find\").")
    P.append("- An Intro / Instrumental / Solo / Outro / Ending row of chords-only: write the section "
             "keyword, then the bars separated by \" / \", each chord bracketed, e.g.\n"
             "    Intro / [Bm] / [G] / [A] / [F#m] /\n"
             "  Append \" ( N Times )\" when that row repeats (e.g. \" ( 2 Times )\").")
    P.append("- A pure chord row with no keyword is just the bracketed bars, e.g. "
             "\"[Bm] / [Bm] / [Bm] / [Bm] /\".")
    P.append("- A line that is only a repeat marker like \"( *, ** )\" or \"( ** )\" stays on its OWN "
             "line. The * / ** labels go at the START of the chorus line they name, e.g. "
             "\"* [Bm]Come On...\", \"** [G]ถ้าหาก...\".")
    P.append("- A turnaround chord drawn at the END of a lyric line (after the last word) stays on "
             "THAT SAME line, appended after the final word — e.g. \"...leave behind. [Fmaj7]\". "
             "NEVER put a single lone chord on its own line. Only a row that is genuinely "
             "chords-only in the image (a full bar row) gets its own line.")
    P.append("- Keep ONE blank line between lyric lines and around each section block, matching the "
             "printed layout.")
    if vocab:
        P.append(f"- Use these chord spellings (the song's vocabulary): {vocab}. "
                 "Sharp = #, flat = b, minor = m, e.g. F#m, Bb, Cmaj7, G/B.")

    if ref_text:
        P.append("\nFORMAT REFERENCE — a DIFFERENT, correctly-formatted song. Copy its FORMATTING "
                 "only, NOT its words or chords:\n----\n" + ref_text.strip() + "\n----")

    if sung:
        P.append("\nThese are the EXACT lyrics (already correct from the page text). Copy them "
                 "VERBATIM — do not re-spell, translate, reorder, or invent words. Use the IMAGE "
                 "only to decide which [Chord] sits above which syllable and to read the chord-only "
                 "Intro/Instru/Outro rows:\n----\n" + "\n".join(sung) + "\n----")
    else:
        P.append("\nThe page had no machine-readable lyrics, so read the lyrics directly from the "
                 "image. Transcribe Thai text carefully and exactly as printed.")

    P.append(f"\nTITLE: {title or '(read from the image)'}")
    P.append("\nNow output the ChordPro text for this song and nothing else.")
    return "\n".join(P)


def clean_output(s):
    """Strip a stray ``` fence and any chatter before the first {title:}."""
    s = s.strip()
    if s.startswith('```'):
        s = re.sub(r'^```[a-zA-Z]*\s*\n', '', s)
        s = re.sub(r'\n```\s*$', '', s)
    i = s.find('{title:')
    if i > 0:
        s = s[i:]
    return s.strip() + '\n'


def call_claude(prompt, model, timeout):
    """Invoke the Claude Code CLI in headless mode, feeding the prompt on stdin (avoids
    arg-length / shell-quoting issues with Thai text). shell=True so Windows resolves the
    npm `claude.cmd` shim. Read is the only tool it's allowed — it can open the image but
    cannot write anything; we capture its stdout as the result."""
    cmd = 'claude -p --allowedTools Read'
    if model:
        cmd += f' --model {model}'
    proc = subprocess.run(
        cmd, input=prompt, capture_output=True, text=True, encoding='utf-8',
        errors='replace', timeout=timeout, shell=True, cwd=ROOT,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'claude -p exited {proc.returncode}: {(proc.stderr or "").strip()[:400]}')
    return proc.stdout or ''


def main():
    _u8()
    ap = argparse.ArgumentParser(description='Re-extract hard/flagged songs with a vision model via `claude -p` (subscription, not API).')
    ap.add_argument('ids', nargs='*', type=int, help='song ids to (re)extract')
    ap.add_argument('--flagged', action='store_true', help='process every id in data/chordpro/_flagged.tsv')
    ap.add_argument('--raw', default='data/chordpro-raw', help='cached OCR intermediates (for title/lyrics/vocab)')
    ap.add_argument('--cache', default='scripts/.chordpro_cache', help='html+image fetch cache (the <id>.png lives here)')
    ap.add_argument('--out', default='data/chordpro', help='ChordPro output dir (bundled by build-data.mjs)')
    ap.add_argument('--vlm-dir', dest='vlm_dir', default='data/chordpro-vlm', help='durable VLM output dir (preferred by --regen)')
    ap.add_argument('--ref-id', dest='ref_id', type=int, default=2, help='id of a clean song to show the model as a format example (0 = none)')
    ap.add_argument('--model', default=None, help='pass a specific model to `claude -p` (default: CLI default)')
    ap.add_argument('--timeout', type=int, default=300, help='per-song timeout in seconds')
    ap.add_argument('--dry-run', dest='dry', action='store_true', help='print the prompt for each id and exit — no model call, no writes')
    ap.add_argument('--force', action='store_true', help='re-run even if data/chordpro-vlm/<id>.txt already exists')
    args = ap.parse_args()

    ids = list(args.ids)
    if args.flagged:
        ids += read_flagged(args.out)
    # de-dup, keep order
    seen = set(); ids = [i for i in ids if not (i in seen or seen.add(i))]
    if not ids:
        print('no ids — pass ids or --flagged (reads data/chordpro/_flagged.tsv)'); sys.exit(2)

    os.makedirs(args.vlm_dir, exist_ok=True); os.makedirs(args.out, exist_ok=True)

    ref_text = None
    if args.ref_id:
        rp = os.path.join(args.out, f'{args.ref_id}.txt')
        if os.path.exists(rp):
            ref_text = open(rp, encoding='utf-8').read()

    ok = fail = skip = 0
    for n, sid in enumerate(ids, 1):
        dst = os.path.join(args.vlm_dir, f'{sid}.txt')
        if os.path.exists(dst) and not args.force and not args.dry:
            print(f'[{n}/{len(ids)}] id={sid} -- already in {args.vlm_dir} (use --force to redo)'); skip += 1; continue

        raw_p = os.path.join(args.raw, f'{sid}.json')
        raw = json.load(open(raw_p, encoding='utf-8')) if os.path.exists(raw_p) else {}
        img_abs = os.path.abspath(os.path.join(args.cache, f'{sid}.png'))
        if not os.path.exists(img_abs):
            print(f'[{n}/{len(ids)}] id={sid} -- NO IMAGE at {img_abs} (run extraction/scrape first)'); fail += 1; continue

        prompt = build_prompt(sid, raw, img_abs, ref_text)
        if args.dry:
            print(f'\n===== PROMPT id={sid} =====\n{prompt}\n'); continue

        print(f'[{n}/{len(ids)}] id={sid} -> claude -p ...', flush=True)
        t0 = time.time()
        try:
            raw_out = call_claude(prompt, args.model, args.timeout)
        except Exception as e:
            print(f'    FAILED: {e}'); fail += 1; continue
        text = clean_output(raw_out)
        if '{title:' not in text or len(text) < 20:
            print(f'    SUSPECT output ({len(text)} chars) — not writing. First 200: {text[:200]!r}'); fail += 1; continue
        open(dst, 'w', encoding='utf-8').write(text)
        open(os.path.join(args.out, f'{sid}.txt'), 'w', encoding='utf-8').write(text)
        print(f'    ok ({time.time() - t0:.0f}s, {len(text)} chars) -> {dst}'); ok += 1

    if not args.dry:
        print(f'\ndone: {ok} ok, {fail} failed, {skip} skipped. '
              f'Run `npm run data` to rebuild songs.bin (or `npm run chordpro:build`).')


if __name__ == '__main__':
    main()
