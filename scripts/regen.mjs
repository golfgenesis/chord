#!/usr/bin/env node
// Fix-workflow helper. Regenerate ChordPro for the given song ids (or ALL when none are
// given) from the cached raw OCR — applying each data/chordpro-overrides/<id>.json — then
// rebuild public/songs.bin. NO OCR is run, so it's fast. Driven by `npm run chordpro:fix`.
//
//   npm run chordpro:fix -- 19 26     regenerate songs 19 & 26, then rebuild the payload
//   npm run chordpro:fix              regenerate every cached song, then rebuild
//
// (A wrapper is needed because `npm run <script> -- <args>` appends args to the END of the
//  command string — they would land on build-data, not on --regen — so we place them here.)
import { spawnSync } from 'node:child_process';

const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).join(' ');

const run = (cmd) => {
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run(`py -3.11 scripts/extract_chordpro.py --regen ${ids}`.trim());
run('node scripts/build-data.mjs');
