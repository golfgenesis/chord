// Gemini ChordPro backfill — chord-sheet image → Inline ChordPro markdown.
//
// Replaces the old local EasyOCR/tesseract pipeline. For each song it sends the
// WebP chord-sheet image to Gemini 2.5 Flash and asks for clean Inline ChordPro
// text, then caches the raw response at  data/songs-md/<id>.md.
//
//   • RESUMABLE — a song whose data/songs-md/<id>.md already exists is skipped,
//     so you can Ctrl+C any time and re-run to pick up where you left off.
//   • FREE-TIER SAFE — a strict delay (default 4000 ms) sits between every image
//     so we stay under the Gemini API free-tier rate limit (~15 req/min).
//   • IMAGE SOURCE — local images/<name>.webp if present (free, fast), else the
//     R2 Custom Domain (VITE_IMAGE_BASE). Filename rules mirror build-data.mjs.
//
// The .md files are NOT bundled into songs.bin — they ship to R2 alongside the
// WebP images (see scripts/upload_md_r2.py) and the client fetches them at view
// time (service worker caches them for offline). songs.bin stays tiny.
//
//   GEMINI_API_KEY=...    (or GOOGLE_API_KEY) — read from .env.local or the env
//
//   node scripts/gemini-backfill.mjs                # all un-extracted songs
//   node scripts/gemini-backfill.mjs --limit 50     # just the next 50 (smoke test)
//   node scripts/gemini-backfill.mjs --start 70570  # only ids >= 70570
//   node scripts/gemini-backfill.mjs --ids 11,19,42 # specific ids (re-runs them)
//   node scripts/gemini-backfill.mjs --force        # re-extract even if cached
//   node scripts/gemini-backfill.mjs --delay 6000   # slower (extra-safe) pacing

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESULTS = path.join(ROOT, "data", "results.json");
const IMAGES_DIR = path.join(ROOT, "images");
const OUT_DIR = path.join(ROOT, "data", "songs-md");

// ── .env.local loader (no dep — mirrors what scripts/_env.py does for Python) ──
function loadEnvLocal() {
  const f = path.join(ROOT, ".env.local");
  if (!fs.existsSync(f)) return;
  for (const raw of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvLocal();

// ── args ──────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const FORCE = process.argv.includes("--force");
const LIMIT = arg("--limit") != null ? Number(arg("--limit")) : Infinity;
const START = arg("--start") != null ? Number(arg("--start")) : 0;
const ONLY_IDS = arg("--ids")
  ? new Set(arg("--ids").split(",").map((s) => Number(s.trim())).filter(Number.isFinite))
  : null;
const DELAY_MS = Number(arg("--delay", "4000")); // strict per-image delay (free tier)
const MODEL = arg("--model", "gemini-2.5-flash");
const IMAGE_BASE = process.env.VITE_IMAGE_BASE || ""; // R2 fallback when no local file

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  console.error(
    "ERROR: no GEMINI_API_KEY (or GOOGLE_API_KEY) found.\n" +
      "Add it to .env.local:  GEMINI_API_KEY=your_key_here\n" +
      "Get a free key at https://aistudio.google.com/apikey",
  );
  process.exit(1);
}

// ── filename mapping (must match scripts/build-data.mjs cleanName + dedup) ────
const INVALID = /[<>:"/\\|?*\x00-\x1f]/g;
const PREFIX = "คอร์ด ";
function cleanName(alt) {
  let s = alt.startsWith(PREFIX) ? alt.slice(PREFIX.length) : alt;
  s = s.replace(INVALID, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return s || "untitled";
}

// ── extraction prompt — yields the format src/lib/chordpro.ts parses ─────────
const PROMPT = `You are an expert music transcriber. You are given an image of a Thai song chord sheet (คอร์ดเพลง). Convert it into clean **Inline ChordPro** text.

STRICT RULES — output ONLY the ChordPro text. No code fences, no commentary, no explanations.

1. INLINE EVERY CHORD. In the image, chords are drawn on a separate line ABOVE the lyrics. DO NOT reproduce that two-line layout. Instead MERGE each chord into the lyric line by writing [Chord] immediately before the exact syllable that sits directly under it.
   WRONG (chord left on its own line above the lyric — never do this):
     [A7]
     น้องเอยน้องคอยพี่หน่อย
   RIGHT (chord merged inline at the syllable beneath it):
     [A7]น้องเอยน้องคอย[D7]พี่หน่อย
   The ONLY lines allowed to carry chords without lyrics are the purely instrumental rows in rule 3.
2. Preserve the lyrics EXACTLY as printed — same words, spelling and line breaks. Do NOT translate, summarise, correct or add lyrics.
3. Purely instrumental / chord-only rows (Intro, Solo, Outro, Instru, turnarounds with no words): keep the section label, then bracket EVERY chord, e.g.  Intro: [C] / [G] / [Am] / [F]   (x2)
4. METADATA — read the TOP of the sheet (near the title / artist) for a key, capo, or tuning note and, only if it is actually visible (never guess), emit it as the FIRST line(s):
   - a stated key  → {key: C}     (use a minor tonic like {key: Am} when the sheet says so)
   - a capo        → {note: Capo 2}
   - a tune-down   → {note: Tune down ½ tone to Eb}
5. Keep one blank line between sections. Use standard chord names (C, G/B, Am7, F#m, Bb, Csus4 …). Keep section markers such as * / ** / (×2) as written.
6. Never invent chords or lyrics that are not visible. Transcribe only what you can read.

Output the ChordPro now:`;

// Strip a leading/trailing ```...``` fence if the model adds one anyway.
function cleanResponse(text) {
  let t = (text ?? "").trim();
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  return t;
}

async function loadImageBase64(name) {
  const local = path.join(IMAGES_DIR, `${name}.webp`);
  if (fs.existsSync(local)) {
    return { data: fs.readFileSync(local).toString("base64"), mimeType: "image/webp" };
  }
  if (!IMAGE_BASE) return null;
  const url = `${IMAGE_BASE}/${encodeURIComponent(name)}.webp`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString("base64"), mimeType: "image/webp" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtEta = (s) => (s === Infinity ? "—" : s < 5400 ? `${(s / 60).toFixed(0)}m` : `${(s / 3600).toFixed(1)}h`);

async function main() {
  if (!fs.existsSync(RESULTS)) {
    console.error(`ERROR: ${RESULTS} not found.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const records = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
  // Case-insensitive collision detection → "_<id>" suffix (mirrors build-data.mjs).
  const counts = new Map();
  for (const r of records) {
    const n = cleanName(r.alt).toLowerCase();
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const nameFor = (r) => {
    const base = cleanName(r.alt);
    return counts.get(base.toLowerCase()) > 1 ? `${base}_${r.id}` : base;
  };

  // Build the work list: not cached (unless --force), passing the id filters.
  let queue = records.filter((r) => {
    if (ONLY_IDS) return ONLY_IDS.has(r.id);
    if (r.id < START) return false;
    if (!FORCE && fs.existsSync(path.join(OUT_DIR, `${r.id}.md`))) return false;
    return true;
  });
  if (Number.isFinite(LIMIT)) queue = queue.slice(0, LIMIT);

  if (queue.length === 0) {
    console.log("nothing to do — every targeted song already has a data/songs-md/<id>.md.");
    return;
  }

  const ai = new GoogleGenAI({ apiKey: API_KEY });
  console.log(
    `gemini-backfill: ${queue.length.toLocaleString()} songs → ${MODEL}, ${DELAY_MS} ms/image` +
      (IMAGE_BASE ? `, R2 fallback ${IMAGE_BASE}` : ", local images only"),
  );

  let ok = 0, skipped = 0, failed = 0;
  const t0 = Date.now();

  for (let i = 0; i < queue.length; i++) {
    const r = queue[i];
    const name = nameFor(r);
    const outPath = path.join(OUT_DIR, `${r.id}.md`);
    try {
      const img = await loadImageBase64(name);
      if (!img) {
        skipped++;
        console.log(`  [${i + 1}/${queue.length}] #${r.id} — no image, skip (${name})`);
        continue; // no delay; nothing was sent
      }

      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ text: PROMPT }, { inlineData: img }],
        config: {
          temperature: 0,
          // Extraction is mechanical — skip the thinking budget so it's fast + cheap.
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      const text = cleanResponse(response.text);
      if (!text) {
        failed++;
        console.log(`  [${i + 1}/${queue.length}] #${r.id} — empty response, skip`);
      } else {
        fs.writeFileSync(outPath, text + "\n", "utf8");
        ok++;
        const el = (Date.now() - t0) / 1000;
        const done = ok + failed + skipped;
        const eta = done > 0 ? (queue.length - done) * (el / done) : Infinity;
        console.log(`  [${i + 1}/${queue.length}] #${r.id} ✓ ${name.slice(0, 40)} — ETA ${fmtEta(eta)}`);
      }
    } catch (err) {
      failed++;
      const msg = String(err?.message || err);
      console.log(`  [${i + 1}/${queue.length}] #${r.id} ✗ ${msg.slice(0, 140)}`);
      // Back off harder on rate-limit / quota errors so a 429 storm settles.
      if (/429|quota|rate|RESOURCE_EXHAUSTED/i.test(msg)) await sleep(DELAY_MS * 4);
    }

    // Strict per-image delay (free-tier pacing) — except after the last one.
    if (i < queue.length - 1) await sleep(DELAY_MS);
  }

  console.log(
    `\ndone — ${ok.toLocaleString()} extracted, ${skipped.toLocaleString()} no-image, ${failed.toLocaleString()} failed.\n` +
      `next:  node scripts/build-data.mjs   (rebuild songs.bin)  &&  py -3.11 scripts/upload_md_r2.py   (push to R2)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
