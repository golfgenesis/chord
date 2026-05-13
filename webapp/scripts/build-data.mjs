// Build a slim songs.json from F:\chord\data\results.json that the webapp ships.
// Strips the unused `src` URL (we serve images locally) and "คอร์ด " prefix.
//
//   results.json record: { id, src, alt: "คอร์ด คำสาป Playground" }
//   songs.json record:   { id, name: "คำสาป Playground", file: "คำสาป Playground.png" }
//
// Filename rules mirror Python sync_names.py exactly.
//
// Run:  node scripts/build-data.mjs

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(PROJECT_ROOT, "data", "results.json");
const OUT_DIR = path.join(__dirname, "..", "public");
const OUT = path.join(OUT_DIR, "songs.json");

const INVALID = /[<>:"/\\|?*\x00-\x1f]/g;
const PREFIX = "คอร์ด ";

function cleanName(alt) {
  let s = alt.startsWith(PREFIX) ? alt.slice(PREFIX.length) : alt;
  s = s.replace(INVALID, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return s || "untitled";
}

if (!fs.existsSync(SRC)) {
  console.warn(`Source ${SRC} not found — keeping existing public/songs.json.`);
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
  const name = cleanName(r.alt);
  const dup = counts.get(name.toLowerCase()) > 1;
  const ext = (() => {
    try {
      return path.extname(new URL(r.src).pathname).toLowerCase() || ".png";
    } catch {
      return ".png";
    }
  })();
  const file = dup ? `${name}_${r.id}${ext}` : `${name}${ext}`;
  return { id: r.id, name: dup ? `${name}_${r.id}` : name, file };
});

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(slim));

const rawSize = fs.statSync(OUT).size;
const gzSize = zlib.gzipSync(fs.readFileSync(OUT)).length;
console.log(`Wrote ${slim.length.toLocaleString()} songs to ${OUT}`);
console.log(`  raw: ${(rawSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`  gzip: ${(gzSize / 1024 / 1024).toFixed(2)} MB`);
