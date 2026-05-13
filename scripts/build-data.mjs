// Build the slim, obfuscated songs payload that the webapp ships.
// Strips the unused `src` URL (images are served separately) and the
// "คอร์ด " prefix from each title.
//
//   results.json record: { id, src, alt: "คอร์ด คำสาป Playground" }
//   slim record:         { id, name: "คำสาป Playground" }
//
// The image file is always `${name}.png` (see src/lib/imageUrl.ts) — keeping
// it out of the payload saves ~30% on the wire. Filename rules mirror Python
// sync_names.py exactly.
//
// Wire format (public/songs.bin):  XOR(gzip(JSON), KEY)
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
  return { id: r.id, name };
});

const json = Buffer.from(JSON.stringify(slim), "utf8");
const gz = zlib.gzipSync(json, { level: 9 });
const klen = KEY.length;
for (let i = 0; i < gz.length; i++) gz[i] ^= KEY[i % klen];

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, gz);
// Remove the legacy plaintext file if it still exists from an older build.
if (fs.existsSync(STALE_JSON)) fs.unlinkSync(STALE_JSON);

console.log(`Wrote ${slim.length.toLocaleString()} songs to ${OUT}`);
console.log(`  json:    ${(json.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  gzip:    ${(gz.length / 1024 / 1024).toFixed(2)} MB (obfuscated)`);
