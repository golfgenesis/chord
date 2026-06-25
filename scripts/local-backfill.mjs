// Local ChordPro backfill — chord-sheet image → Inline ChordPro markdown,
// extracted 100% on-device via a local Ollama vision model. No cloud API, no
// API key, no per-image rate limit, no daily quota. Replaces the old Gemini
// (@google/genai) cloud pipeline.
//
// For each song it sends the WebP chord-sheet image to your local Ollama
// runtime (default model: qwen2.5vl:7b) and writes the returned Inline
// ChordPro to  data/songs-md/<id>.md.
//
//   • LOCAL ONLY  — POSTs to http://127.0.0.1:11434/api/generate (override with
//     OLLAMA_HOST). Nothing leaves the Mac. A preflight checks the server is up
//     and the model is pulled, and prints the exact `ollama pull` fix if not.
//   • RESUMABLE   — a song whose data/songs-md/<id>.md already exists is skipped,
//     so you can Ctrl+C any time and re-run to pick up where you left off.
//   • NO DELAYS   — runs back-to-back as fast as Apple-Silicon unified memory can
//     compute. No sleep gate, no 429/503 circuit breaker, no rate config (all of
//     that was cloud-only and is gone). --concurrency stays 1 by default because
//     a single Ollama model is GPU-bound and serializes anyway; bump it only if
//     you set OLLAMA_NUM_PARALLEL on the server.
//   • IMAGE SOURCE — local images/<name>.webp if present (fast), else the R2
//     Custom Domain (VITE_IMAGE_BASE). Name mapping mirrors build-data.mjs, so
//     it matches the R2 bucket exactly (no 404 lookup misses).
//   • WEBP → PNG — Ollama / llama.cpp does NOT decode WebP (it 400s with
//     "Failed to load image"), and the whole catalogue is WebP, so each image is
//     transcoded to PNG with macOS-native `sips` (ImageIO, no extra dependency)
//     before it's sent. On a non-mac host install libwebp's `dwebp` or supply
//     PNGs instead.
//
// The .md files are NOT bundled into songs.bin — they ship to R2 alongside the
// WebP images (scripts/upload_md_r2.py) and the client fetches them per song at
// view time (the service worker caches them for offline). songs.bin stays tiny.
//
//   node scripts/local-backfill.mjs                 # all un-extracted songs
//   node scripts/local-backfill.mjs --limit 50      # just the next 50 (smoke test)
//   node scripts/local-backfill.mjs --start 70570   # only ids >= 70570
//   node scripts/local-backfill.mjs --ids 11,19,42  # specific ids (re-runs them)
//   node scripts/local-backfill.mjs --force                  # re-extract even if cached
//   node scripts/local-backfill.mjs --model llama3.2-vision  # different local model
//   node scripts/local-backfill.mjs --concurrency 2          # only if OLLAMA_NUM_PARALLEL>1
//   OLLAMA_HOST=http://127.0.0.1:11434  OLLAMA_MODEL=...      # env overrides

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESULTS = path.join(ROOT, "data", "results.json");
const IMAGES_DIR = path.join(ROOT, "images");
const OUT_DIR = path.join(ROOT, "data", "songs-md");

// ── .env.local loader (no dep — mirrors what scripts/_env.py does for Python) ──
// Only used now for VITE_IMAGE_BASE (R2 image fallback) and the optional
// OLLAMA_* overrides. No AI key is read or required.
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
// A single Ollama model is GPU/unified-memory bound and serializes requests
// internally unless the server is started with OLLAMA_NUM_PARALLEL>1 — so the
// honest default is sequential, back-to-back, with zero artificial delay.
const CONCURRENCY = Math.max(1, Number(arg("--concurrency", "1")));
// Per-request timeout. Generous because the FIRST request also loads the model
// into unified memory (cold start can take tens of seconds). Vision inference
// itself is usually seconds. 0 disables the timeout entirely.
const TIMEOUT_MS = Math.max(0, Number(arg("--timeout", "300000")));
const MODEL = arg("--model", process.env.OLLAMA_MODEL || "qwen2.5vl:7b");
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, "");
const GENERATE_URL = `${OLLAMA_HOST}/api/generate`;
const TAGS_URL = `${OLLAMA_HOST}/api/tags`;
const IMAGE_BASE = process.env.VITE_IMAGE_BASE || ""; // R2 fallback when no local file

// ── filename mapping (must match scripts/build-data.mjs cleanName + dedup) ────
// This is the name-based scheme that matches the R2 bucket exactly, so the
// image lookup never 404s. NOTE: this maps to the IMAGE input (<name>.webp).
// The .md OUTPUT is keyed by numeric id (<id>.md) — that is the contract the
// client (src/lib/chordText.ts), the uploader (upload_md_r2.py) and the build
// (build-data.mjs) all depend on. Do not change the .md scheme to name-based.
const INVALID = /[<>:"/\\|?*\x00-\x1f]/g;
const PREFIX = "คอร์ด ";
function cleanName(alt) {
  let s = alt.startsWith(PREFIX) ? alt.slice(PREFIX.length) : alt;
  s = s.replace(INVALID, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return s || "untitled";
}

// ── local system instruction for the Qwen-VL / DeepSeek-VL class vision model ──
const SYSTEM_INSTRUCTION = `You are a precise music transcription model running locally on Mac. Your critical task is to scan this chord sheet image and extract the chords and lyrics directly into a standard Markdown file using valid inline ChordPro notation.

STRICT INLINE LAYOUT RULES:
1. Chords must NEVER exist on an isolated, separate line sitting above the lyrics. You must interweave them.
2. Every single chord marker must be encapsulated within square brackets \`[...]\` and placed inline immediately preceding the exact Thai character, vowel, or syllable it vertically aligns with (e.g., \`[D]คำสาป [A]ที่ฉันต้อง[D]เจอทุกๆคราว\`).
3. For continuous instrumental loops or intro/instru lines that contain only chord indicators, wrap every single token inside brackets, including slash chords (e.g., \`[Bm][G][A]/[F#m]\`). Maintain the exact text-spacing layout.
4. Capture any visible original key or capo markers at the very top of the image sheet, writing them down on the first line using tags: \`{key: KeyName}\` or \`{note: Capo Info}\`.

Do not wrap the final output inside markdown code block backticks (\`\`\`markdown). Output ONLY the raw textual inline ChordPro document. No preambles, no chatbot introductory notes, and no conversational chat fluff.`;

// Short user-turn prompt; the image rides alongside it. The heavy lifting is in
// the system instruction above.
const USER_PROMPT = "Transcribe the attached chord-sheet image into inline ChordPro now.";

// Strip a leading/trailing ```...``` fence and any <think>...</think> block (the
// configured default and several Ollama vision models are "thinking"-capable and
// may emit reasoning before the answer).
function cleanResponse(text) {
  let t = (text ?? "").trim();
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  return t;
}

// ── WebP → PNG transcode (Ollama can't read WebP; see header note) ───────────
// macOS `sips` reads WebP via ImageIO and writes PNG with no extra dependency.
function findSips() {
  if (process.platform !== "darwin") return null;
  for (const p of ["/usr/bin/sips", "/usr/local/bin/sips"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const SIPS = findSips();
let tmpSeq = 0;

// Transcode a WebP file on disk to PNG and return the PNG as base64, or null on
// failure. Cleans up its temp output file.
function webpFileToPngBase64(webpPath) {
  if (!SIPS) return null;
  const out = path.join(os.tmpdir(), `chordpro-${process.pid}-${tmpSeq++}.png`);
  try {
    const r = spawnSync(SIPS, ["-s", "format", "png", webpPath, "--out", out], { stdio: "ignore" });
    if (r.status !== 0 || !fs.existsSync(out)) return null;
    return fs.readFileSync(out).toString("base64");
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* best effort */ }
  }
}

// Returns PNG base64 for the song's chord-sheet image (local first, else R2), or
// null when the image is missing / can't be transcoded.
async function loadImageBase64(name) {
  const local = path.join(IMAGES_DIR, `${name}.webp`);
  if (fs.existsSync(local)) {
    return webpFileToPngBase64(local);
  }
  if (!IMAGE_BASE) return null;
  const url = `${IMAGE_BASE}/${encodeURIComponent(name)}.webp`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  // sips needs a file on disk; stage the downloaded WebP, then transcode.
  const tmpWebp = path.join(os.tmpdir(), `chordpro-${process.pid}-${tmpSeq++}.webp`);
  try {
    fs.writeFileSync(tmpWebp, buf);
    return webpFileToPngBase64(tmpWebp);
  } finally {
    try { fs.rmSync(tmpWebp, { force: true }); } catch { /* best effort */ }
  }
}

const fmtEta = (s) => (s === Infinity ? "—" : s < 5400 ? `${(s / 60).toFixed(0)}m` : `${(s / 3600).toFixed(1)}h`);

// One local generate call. Throws on transport error or non-200 (logged + counted
// by the caller, which just moves on — there is no cloud rate/quota wall to back
// off from locally).
async function ollamaGenerate(imageB64) {
  const ctrl = TIMEOUT_MS > 0 ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetch(GENERATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl?.signal,
      body: JSON.stringify({
        model: MODEL,
        system: SYSTEM_INSTRUCTION,
        prompt: USER_PROMPT,
        images: [imageB64],
        stream: false,
        keep_alive: "30m", // keep the model resident between songs (no reload tax)
        options: { temperature: 0, num_predict: 4096 },
      }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${body}`);
    }
    const json = await res.json();
    return json.response ?? "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Preflight: server reachable + the chosen model is pulled. Bail with an
// actionable message instead of failing one-by-one across the whole queue.
async function preflight() {
  let tags;
  try {
    const res = await fetch(TAGS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tags = await res.json();
  } catch (e) {
    console.error(
      `ERROR: can't reach Ollama at ${OLLAMA_HOST} (${String(e?.message || e)}).\n` +
        "  • Install:  https://ollama.com/download\n" +
        "  • Start it: run `ollama serve` (or just launch the Ollama app)\n" +
        "  • Override host with the OLLAMA_HOST env var.",
    );
    process.exit(1);
  }
  const names = (tags.models || []).map((m) => m.name);
  const present = names.includes(MODEL) || names.includes(`${MODEL}:latest`);
  if (!present) {
    console.error(
      `ERROR: model "${MODEL}" is not pulled in Ollama.\n` +
        `  • Pull it:  ollama pull ${MODEL}\n` +
        (names.length
          ? `  • Installed vision-capable models you could use with --model:\n` +
            names.map((n) => `      - ${n}`).join("\n") +
            "\n"
          : "  • You have no models pulled yet.\n") +
        `  • Then re-run, or pick one now:  node scripts/local-backfill.mjs --model <name>`,
    );
    process.exit(1);
  }
  if (!SIPS) {
    console.warn(
      "WARNING: no `sips` found (macOS ImageIO WebP→PNG transcoder).\n" +
        "  Ollama can't decode WebP, and the catalogue is all WebP — every image\n" +
        "  will be skipped. On macOS sips ships with the OS; on another host,\n" +
        "  install libwebp's `dwebp` and adapt webpFileToPngBase64(), or feed PNGs.",
    );
  }
  return true;
}

async function main() {
  if (!fs.existsSync(RESULTS)) {
    console.error(`ERROR: ${RESULTS} not found.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await preflight();

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

  console.log(
    `local-backfill: ${queue.length.toLocaleString()} songs → ${MODEL} @ ${OLLAMA_HOST}, ` +
      `concurrency ${CONCURRENCY}` +
      (IMAGE_BASE ? `, R2 image fallback ${IMAGE_BASE}` : ", local images only"),
  );

  let ok = 0, skipped = 0, failed = 0;
  const t0 = Date.now();

  async function processOne(r) {
    const name = nameFor(r);
    const outPath = path.join(OUT_DIR, `${r.id}.md`);
    try {
      const img = await loadImageBase64(name);
      if (!img) {
        skipped++;
        console.log(`  #${r.id} — no image, skip (${name})`);
        return;
      }
      const raw = await ollamaGenerate(img);
      const text = cleanResponse(raw);
      if (!text) {
        failed++;
        console.log(`  #${r.id} — empty response, skip`);
        return;
      }
      fs.writeFileSync(outPath, text + "\n", "utf8");
      ok++;
      const done = ok + failed + skipped;
      const el = (Date.now() - t0) / 1000;
      const rate = el > 0 ? (ok / el) * 60 : 0;
      const eta = done > 0 ? (queue.length - done) * (el / done) : Infinity;
      console.log(`  [${done}/${queue.length}] #${r.id} ✓ ${name.slice(0, 36)} — ${rate.toFixed(1)}/min · ETA ${fmtEta(eta)}`);
    } catch (err) {
      failed++;
      console.log(`  #${r.id} ✗ ${String(err?.message || err).slice(0, 160)}`);
    }
  }

  // Concurrent worker pool. Each worker pulls the next queue index until the
  // queue drains. The file-skip filter above already left only un-done songs in
  // `queue`, so the whole run stays resumable across Ctrl+C / re-runs.
  let nextIdx = 0;
  async function worker() {
    for (;;) {
      const i = nextIdx++;
      if (i >= queue.length) return;
      await processOne(queue[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()),
  );

  console.log(
    `\ndone — ${ok.toLocaleString()} extracted, ${skipped.toLocaleString()} no-image, ${failed.toLocaleString()} failed.\n` +
      `next:  node scripts/build-data.mjs   (rebuild songs.bin)  &&  python3 scripts/upload_md_r2.py   (push to R2)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
