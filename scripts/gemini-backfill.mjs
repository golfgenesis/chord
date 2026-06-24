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
// Circuit breaker: stop the run cleanly after this many BACK-TO-BACK rate /
// quota / 503 errors (i.e. we've hit the daily-quota or overload wall). The
// run exits 0 and is resumable — a 24/7 wrapper just sleeps and retries later,
// instead of churning the whole queue against a wall. 0 disables it.
const MAX_RATE_ERRORS = Number(arg("--max-rate-errors", "6"));
// Transient errors worth backing off on AND counting toward the breaker.
const RATE_RE = /\b429\b|\b503\b|quota|rate|RESOURCE_EXHAUSTED|UNAVAILABLE|overload|high demand/i;

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

// ── system instruction (passed as Gemini `config.systemInstruction`) ─────────
// ⚠ NOTE: this prompt asks the model for Markdown `### Section` headings, but the
// in-app renderer (src/lib/chordpro.ts → ChordSheet.tsx) does NOT parse Markdown
// headings — a `### Intro` line currently renders as the literal text "### Intro".
// The renderer understands ChordPro directives, chord-only rows, and lyric lines
// only. Either extend the parser to treat `#`/`##`/`###` lines as section headers,
// or drop the heading instruction, before backfilling at scale.
const SYSTEM_INSTRUCTION = `
You are an expert music transcription assistant. Your critical task is to extract the lyrics and chords from this song sheet image and format the output directly into a standard Markdown file using valid inline ChordPro notation.

CRITICAL ALIGNMENT RULES FOR THAI LYRICS & EN CHORDS:
1. You must perform a rigorous character-by-character visual alignment tracking. In the source image, English chord markers sit exactly above specific Thai characters or syllables.
2. You MUST preserve this horizontal layout position by embedding each chord marker inside square brackets \`[...]\` IMMEDIATELY BEFORE the exact Thai syllable or character it aligns with vertically (e.g., convert a chord 'Bm' sitting over 'เรา' into \`คน[Bm]เราหก[G]ล้ม\`).
3. NEVER place chord brackets on their own separate lines above the lyrics. Chords and lyrics must be tightly interwoven into a single consolidated row per line.
4. For lines with multiple continuous chords or instrumental rows (Intro/Instru), wrap EVERY single chord token inside its own brackets, including slash chords (e.g., \\\`[Bm][G][A]/[F#m]\\\`). Preserve the exact text-spacing between chords on these rows.
5. Do not guess or shift the chords to generic starting positions. Treat the vertical synchronization as an absolute layout requirement.
6. Look for original key or capo annotations at the very top of the image sheet. If visible, emit them using standard ChordPro tags (e.g., \`{key: D}\` or \`{note: Capo 1}\`) on the first lines of the markdown document.

DOCUMENT STRUCTURE:
- Organize section transitions cleanly using standard Markdown headings (e.g., \`### Intro\`, \`### Verse 1\`, \`### Chorus\`).
- Maintain chorus repeat markers (*) or instrumental cues verbatim.
- Output ONLY the raw formatted markdown text content block. Do not surround the final output with markdown code backticks (\`\`\`markdown), and do not provide any introductory commentary, preambles, or any conversational filler responses.
`;

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

  let ok = 0, skipped = 0, failed = 0, consecutiveRateErrors = 0, hitWall = false;
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
        contents: [{ inlineData: img }],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
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
        consecutiveRateErrors = 0; // a success means we're not at the wall
        const el = (Date.now() - t0) / 1000;
        const done = ok + failed + skipped;
        const eta = done > 0 ? (queue.length - done) * (el / done) : Infinity;
        console.log(`  [${i + 1}/${queue.length}] #${r.id} ✓ ${name.slice(0, 40)} — ETA ${fmtEta(eta)}`);
      }
    } catch (err) {
      failed++;
      const msg = String(err?.message || err);
      console.log(`  [${i + 1}/${queue.length}] #${r.id} ✗ ${msg.slice(0, 140)}`);
      if (RATE_RE.test(msg)) {
        consecutiveRateErrors++;
        // Circuit breaker: we've hit the daily-quota / overload wall. Stop now
        // (resumable) rather than failing the rest of the queue one by one.
        if (MAX_RATE_ERRORS > 0 && consecutiveRateErrors >= MAX_RATE_ERRORS) {
          hitWall = true;
          console.log(
            `\n⚠ hit the rate/quota wall (${consecutiveRateErrors} consecutive 429/503/quota errors).` +
              ` Stopping cleanly — re-run later to resume (done songs are skipped).`,
          );
          break;
        }
        await sleep(DELAY_MS * 4); // back off harder so a 429/503 spike settles
      }
    }

    // Strict per-image delay (free-tier pacing) — except after the last one.
    if (i < queue.length - 1) await sleep(DELAY_MS);
  }

  console.log(
    `\ndone — ${ok.toLocaleString()} extracted, ${skipped.toLocaleString()} no-image, ${failed.toLocaleString()} failed` +
      (hitWall ? " (stopped at rate/quota wall — resumable)" : "") +
      `.\nnext:  node scripts/build-data.mjs   (rebuild songs.bin)  &&  python3 scripts/upload_md_r2.py   (push to R2)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
