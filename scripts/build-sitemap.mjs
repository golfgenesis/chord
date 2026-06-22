// Build the SEO sitemap from the songs payload.
//
// Only songs that have inline ChordPro TEXT (`cp`) are listed — those are the
// pages with real, crawlable content. Image-only songs are skipped (thin pages
// → would hurt SEO; the edge function marks any it serves as `noindex`). As the
// backfill (`npm run chordpro:backfill`) converts more songs, re-run this and
// the indexable set grows automatically.
//
// Output (into public/, shipped to dist/ by Vite):
//   public/sitemap.xml            — sitemap INDEX
//   public/sitemaps/pages.xml     — the homepage
//   public/sitemaps/songs-N.xml   — up to 45,000 song URLs each
//
// URLs match functions/song/[[path]].js: /song/<id>/<slug>. The slugify() here
// MUST stay byte-identical to the one in that function, or canonical URLs drift.
//
// Run AFTER `npm run data` (which writes public/songs.bin):  node scripts/build-sitemap.mjs

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SITE_URL } from "./_site.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "public", "songs.bin");
const PUBLIC = path.join(ROOT, "public");
const SITEMAP_DIR = path.join(PUBLIC, "sitemaps");

// MUST match scripts/build-data.mjs + src/lib/songsCodec.ts.
const XOR_KEY_HEX = "9c4f1d6a3e80b5b27cdb1f24a8e6b35a2710f87c4d65e3b9af8c01d72e64b395";
const KEY = Buffer.from(XOR_KEY_HEX, "hex");

const PER_FILE = 45000; // sitemap spec caps at 50,000 URLs / 50MB per file.

/** Decode public/songs.bin → array of slim song records. */
function decodeSongs(buf) {
  const x = Buffer.from(buf);
  for (let i = 0; i < x.length; i++) x[i] ^= KEY[i % KEY.length];
  return JSON.parse(zlib.gunzipSync(x).toString("utf8"));
}

/** Slug for the URL path. MUST match functions/song/[[path]].js:slugify(). */
export function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^\p{L}\p{N}-]+/gu, "") // keep letters (incl. Thai) + digits + hyphen
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "song"
  );
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function songUrl(song) {
  // encodeURIComponent the slug (Thai → %xx), then XML-escape for the <loc>.
  return `${SITE_URL}/song/${song.id}/${encodeURIComponent(slugify(song.name))}`;
}

function urlsetXml(urls) {
  const body = urls
    .map((u) => `  <url><loc>${xmlEscape(u)}</loc><changefreq>weekly</changefreq></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function indexXml(childPaths) {
  const body = childPaths
    .map((p) => `  <sitemap><loc>${xmlEscape(SITE_URL + p)}</loc></sitemap>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

function main() {
  if (!fs.existsSync(BIN)) {
    console.warn(`build-sitemap: ${BIN} not found — run \`npm run data\` first. Skipping.`);
    process.exit(0);
  }
  const songs = decodeSongs(fs.readFileSync(BIN));
  const withText = songs.filter((s) => s.cp);
  console.log(`build-sitemap: ${songs.length} songs, ${withText.length} with ChordPro text (indexable).`);

  fs.mkdirSync(SITEMAP_DIR, { recursive: true });

  // Homepage sitemap.
  fs.writeFileSync(path.join(SITEMAP_DIR, "pages.xml"), urlsetXml([`${SITE_URL}/`]));

  // Song sitemaps, chunked.
  const childPaths = ["/sitemaps/pages.xml"];
  for (let i = 0, part = 1; i < withText.length; i += PER_FILE, part++) {
    const chunk = withText.slice(i, i + PER_FILE);
    const file = `songs-${part}.xml`;
    fs.writeFileSync(path.join(SITEMAP_DIR, file), urlsetXml(chunk.map(songUrl)));
    childPaths.push(`/sitemaps/${file}`);
    console.log(`  wrote sitemaps/${file} (${chunk.length} urls)`);
  }

  fs.writeFileSync(path.join(PUBLIC, "sitemap.xml"), indexXml(childPaths));
  console.log(`build-sitemap: wrote public/sitemap.xml (index of ${childPaths.length} sitemaps).`);
}

// Run only when executed directly (so tests can import slugify without side effects).
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
