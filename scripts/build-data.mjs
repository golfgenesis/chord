// Build the slim, obfuscated songs payload that the webapp ships.
// Strips the unused `src` URL (images are served separately) and the
// "คอร์ด " prefix from each title.
//
//   results.json record: { id, src, alt: "คอร์ด คำสาป Playground" }
//   slim record:         { id, name: "คำสาป Playground" }   (+ t:1 if it has text)
//
// The image file is always `${name}.webp` (see src/lib/imageUrl.ts) — keeping
// it out of the payload saves ~30% on the wire. The on-disk dataset under
// `images/` is the WebP set that R2 actually serves. Filename rules
// (Windows-sanitization, "_${id}" disambiguation on case-insensitive
// collisions) mirror Python sync_names.py exactly.
//
// ChordPro TEXT is deliberately NOT bundled here. It lives as data/songs-md/
// <id>.md (Gemini backfill) → uploaded to R2 → fetched per-song at view time
// and SW-cached for offline. The payload only carries a 1-byte `t: 1` marker
// for songs that have a sheet, so the SEO Pages Function (functions/song) and
// any "indexable set" logic stay cheap without shipping the text to every
// client. This is what keeps songs.bin tiny for the 10 ms in-memory search.
//
// Wire format (public/songs.bin):  XOR(brotli(JSON), KEY)
// Brotli (quality 11) is ~37% smaller than gzip on this dataset. The browser
// can't decode brotli via DecompressionStream (that API only does gzip/deflate),
// so the client decodes with the `brotli` npm package — see src/lib/songsCodec.ts;
// the SSR Pages Function (functions/song) decodes the same way. zlib's brotli
// output is standard RFC 7932, so the JS-package decoder reads it byte-for-byte.
// The same KEY is hard-coded in src/lib/songsCodec.ts — if you change one,
// change both, or existing clients won't be able to decode the new bundle.
//
// Run:  node scripts/build-data.mjs

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(PROJECT_ROOT, "data", "results.json");
const OUT_DIR = path.join(PROJECT_ROOT, "public");
const OUT = path.join(OUT_DIR, "songs.bin");
const STALE_JSON = path.join(OUT_DIR, "songs.json");

// MUST stay in sync with src/lib/songsCodec.ts:XOR_KEY_HEX
const XOR_KEY_HEX =
  "9c4f1d6a3e80b5b27cdb1f24a8e6b35a2710f87c4d65e3b9af8c01d72e64b395";
const KEY = Buffer.from(XOR_KEY_HEX, "hex");

const INVALID = /[<>:"/\\|?*\x00-\x1f]/g;
const PREFIX = "คอร์ด ";

function cleanName(alt) {
  let s = alt.startsWith(PREFIX) ? alt.slice(PREFIX.length) : alt;
  s = s.replace(INVALID, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return s || "untitled";
}

if (!fs.existsSync(SRC)) {
  console.warn(`Source ${SRC} not found — keeping existing public/songs.bin.`);
  process.exit(0);
}
const records = JSON.parse(fs.readFileSync(SRC, "utf8"));

// Which songs have a ChordPro sheet? We only need the SET of ids — the text
// itself ships to R2 as data/songs-md/<id>.md and is fetched per song at view
// time (NOT bundled). The `t: 1` marker below lets the SEO Pages Function and
// the "indexable / related songs" logic know which pages have real content,
// without paying the payload cost of the full markdown for every client.
const SONGS_MD_DIR = path.join(PROJECT_ROOT, "data", "songs-md");
const hasText = new Set();
if (fs.existsSync(SONGS_MD_DIR)) {
  for (const f of fs.readdirSync(SONGS_MD_DIR)) {
    const m = f.match(/^(\d+)\.md$/);
    if (m) hasText.add(Number(m[1]));
  }
}

// Case-insensitive collision detection (matches Windows + Python logic)
const counts = new Map();
for (const r of records) {
  const name = cleanName(r.alt).toLowerCase();
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

const slim = records.map((r) => {
  const base = cleanName(r.alt);
  const dup = counts.get(base.toLowerCase()) > 1;
  const name = dup ? `${base}_${r.id}` : base;
  const rec = { id: r.id, name };
  if (hasText.has(r.id)) rec.t = 1; // has a ChordPro sheet on R2 (indexable)
  return rec;
});
console.log(
  `build-data: ${slim.length} songs, ${hasText.size} with ChordPro text (on R2)`,
);

const json = Buffer.from(JSON.stringify(slim), "utf8");
const compressed = zlib.brotliCompressSync(json, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11, // max ratio (build-time, one-off)
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: json.length,
  },
});
const klen = KEY.length;
for (let i = 0; i < compressed.length; i++) compressed[i] ^= KEY[i % klen];

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, compressed);
// Remove the legacy plaintext file if it still exists from an older build.
if (fs.existsSync(STALE_JSON)) fs.unlinkSync(STALE_JSON);

console.log(`Wrote ${slim.length.toLocaleString()} songs to ${OUT}`);
console.log(`  json:    ${(json.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  brotli:  ${(compressed.length / 1024 / 1024).toFixed(2)} MB (obfuscated)`);
