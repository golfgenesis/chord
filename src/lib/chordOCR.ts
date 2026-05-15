// Client-side OCR for chord sheets. We use Tesseract.js with an English-only
// language model and a chord-symbol character whitelist — that's enough to
// pick out the bold chord labels printed above each lyric line, while making
// Tesseract effectively blind to Thai script (which has no overlapping
// glyphs with the whitelist). The whitelist also makes recognition faster
// because the engine has fewer candidates to score per glyph.
//
// Returned bounding boxes are in the IMAGE'S NATURAL pixel coordinates.
// Consumers (the overlay) must convert to displayed coordinates using the
// scale factor implied by `object-contain`.

import { get as idbGet, set as idbSet } from "idb-keyval";
import { snapChord } from "./chordVocab";

export interface ChordToken {
  text: string;     // Normalized chord symbol (e.g. "Am7", "F#", "Bb")
  raw: string;      // Original OCR text before normalization
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number; // 0..100 — Tesseract's per-word confidence
}

export interface OCRResult {
  chords: ChordToken[];
  width: number;    // image natural width — bbox coordinate space
  height: number;   // image natural height
  durationMs: number;
  ocrVersion: number; // bump to invalidate cache on regex/whitelist changes
}

// Bump when CHORD_REGEX, NORMALIZE_MAP, or whitelist materially changes —
// caches recognised under an older version will be ignored.
const OCR_VERSION = 8;
const CACHE_PREFIX = "chordroom/ocr/v" + OCR_VERSION + "/";

// Tesseract has a habit of reading "0" for "O", "1" for "I", "S" for "5",
// and confusing the degree sign with "o" / "0". Normalize the common
// substitutions before regex-filtering so we don't drop perfectly readable
// tokens to noise.
const NORMALIZE_MAP: Record<string, string> = {
  "º": "°",
  "˚": "°",
  "0": "°", // standalone "0" inside a chord context usually means diminished
};

// Whitelist of characters Tesseract is allowed to emit. The set is
// intentionally tight — every char that's not on this list is treated as
// noise and not output, which mostly means Thai vowels / consonants and
// stray symbols. We include the degree sign and both Unicode + ASCII
// accidentals because chord sheets vary by source.
const CHORD_CHARSET = "ABCDEFGabcdefgHmajinsudo°#♯b♭/0123456789+-";

// Confidence floors. The single-letter floor exists because plain "A" or
// "B" tokens are valid chord names AND valid English filler words ("A
// road", a "B side"); the chord-line-density gate downstream usually
// catches the lyric case, so we can keep these tolerant enough that
// chord letters Tesseract is "fairly sure" about still get through.
// Section-header rows like "Intro D" / "Instru D / A / F#m / E" suffer
// the most from over-aggressive floors: the chord letters there are the
// same size as in the body but Tesseract often scores them slightly
// lower (the inline word "Intro" / "Instru" beside them slightly biases
// the recogniser), and a floor of 55 would silently drop the chord.
const SINGLE_LETTER_CONFIDENCE_MIN = 40;
const MIN_CONFIDENCE_OVERALL = 25;

function normalizeRaw(raw: string): string {
  let out = "";
  for (const ch of raw) {
    out += NORMALIZE_MAP[ch] ?? ch;
  }
  // Strip leading/trailing punctuation (Tesseract often glues commas,
  // periods, parens, closing brackets, etc. onto chord tokens). We keep
  // the slash because it's a real chord separator (G/B), and the
  // accidental glyphs because they're part of the chord. Trailing slash
  // gets a second pass because "Intro / D /" frequently lands as "D/"
  // after the first strip (the slash itself is in the keep-set).
  out = out
    .replace(/^[^A-Za-z0-9#♯b♭°]+/, "")
    .replace(/[^A-Za-z0-9#♯b♭°/]+$/, "")
    .replace(/\/$/, "")
    .trim();
  // Uppercase the leading note letter. Tesseract on bold sans-serif chord
  // labels occasionally reads "A" as "a" / "B" as "b" — both should still
  // resolve to the same chord.
  if (out.length > 0 && out[0] >= "a" && out[0] <= "g") {
    out = out[0].toUpperCase() + out.slice(1);
  }
  return out;
}

/**
 * Run a normalised OCR token through the chord vocabulary's fuzzy snapper.
 * Returns the canonical chord name when the token matches (exactly or
 * within the per-length edit-distance budget enforced by
 * [chordVocab.snapChord](./chordVocab.ts)), otherwise null. The snapper
 * replaces the old strict-regex filter because Tesseract on stylised
 * chord fonts emits enough single-character errors ("m" → "rn", "#" → "$",
 * "j" → "i") that strict matching dropped a third of real chords on
 * busy chord sheets.
 */
function snapToken(token: string, confidence: number): string | null {
  if (!token) return null;
  if (confidence < MIN_CONFIDENCE_OVERALL) return null;
  if (token.length === 1 && confidence < SINGLE_LETTER_CONFIDENCE_MIN) return null;
  return snapChord(token);
}

// Lazy singleton — the worker is heavy to spin up (downloads WASM + model),
// so we initialise once and reuse it across calls. The first call pays the
// startup cost (~3–6 s); subsequent calls are warm and only pay the per-page
// OCR time.
type TesseractWorker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;

let workerPromise: Promise<TesseractWorker> | null = null;
function getWorker(): Promise<TesseractWorker> {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const tesseract = await import("tesseract.js");
    const w = await tesseract.createWorker("eng");
    await w.setParameters({
      tessedit_char_whitelist: CHORD_CHARSET,
      // PSM 11: "sparse text — find as much text as possible in no
      // particular order". Beats the default "auto block" mode on chord
      // sheets because chord labels aren't laid out as continuous prose.
      tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
    });
    return w;
  })();
  return workerPromise;
}

// Tesseract's per-page result tree. We only project the fields we need so
// the imports stay narrow.
type TesseractWord = {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};
type TesseractLine = { words: TesseractWord[] };
type TesseractPage = {
  blocks: Array<{ paragraphs: Array<{ lines: TesseractLine[] }> }> | null;
};

function eachLine(page: TesseractPage): TesseractLine[] {
  const out: TesseractLine[] = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) out.push(line);
    }
  }
  return out;
}

// A line qualifies as a "chord line" when at least this fraction of its
// substantive tokens (anything that survives normalisation — i.e. not
// pure punctuation) snap to a chord in the vocabulary. The threshold is
// permissive on purpose: header rows like "Intro / Amaj9 / E7 / ( 2
// Times )" come in with ratio ≈ 0.35 because Tesseract picks up the
// section label "Intro" plus the "( 2 Times )" annotation alongside the
// two real chords. Setting the gate at 0.5 (or even 0.4) used to drop
// the entire row and the user saw black, untransposed chord text where
// red overlays should have appeared. The bulk-count gate and short-line
// gate downstream are the other two ways a line can qualify; this is the
// most-forgiving of the three.
const CHORD_LINE_RATIO_MIN = 0.3;

interface LineToken {
  word: TesseractWord;
  normalized: string;
  // The snapped canonical chord name, or null if the token didn't match
  // anything in the vocabulary. Stored alongside the raw text so we can
  // both classify the line (chord-density ratio uses `snapped !== null`)
  // and persist the cleaned-up chord name to the cache.
  snapped: string | null;
}

// Minimum absolute number of snapped chord tokens for a line to qualify
// as a chord row even when the ratio gate misses. Some sheets have lines
// like "Intro / D / G / Em / A /" where Tesseract may also pick up the
// word "Intro" plus stray noise tokens — the chord-only ratio dips below
// 0.5, but the line still clearly carries chord positions worth
// overlaying. Two-or-more snapped tokens is a strong signal that we're
// looking at chords, not lyrics.
const CHORD_LINE_MIN_COUNT = 2;

// Even a SINGLE snapped chord on a very short line is almost certainly
// real — chord sheets often have header rows like "Intro D" or
// "Outro G" with just one chord. We treat any line with ≤ 4 substantive
// tokens and ≥ 1 snapped chord as a valid chord row. Long lines aren't
// covered here because a stray chord-shape inside a lyric line is more
// likely a false positive than music.
const SHORT_LINE_MAX_SUBSTANTIVE = 4;

function extractChordsFromLine(
  line: TesseractLine,
  bboxScale: number,
): ChordToken[] {
  const tokens: LineToken[] = [];
  for (const word of line.words ?? []) {
    const raw = (word.text ?? "").trim();
    if (!raw) continue;
    const normalized = normalizeRaw(raw);
    if (!normalized) continue; // pure punctuation / stripped to empty
    const snapped = snapToken(normalized, word.confidence ?? 0);
    tokens.push({ word, normalized, snapped });
  }
  if (tokens.length === 0) return [];

  const chordCount = tokens.reduce((n, t) => (t.snapped !== null ? n + 1 : n), 0);
  const ratio = chordCount / tokens.length;
  // Three independent ways for a line to qualify as a chord row:
  //   - density: most substantive tokens snap to chords
  //   - bulk:    enough snapped chords to be statistically obvious
  //   - header:  a short line with at least one chord (catches one-chord
  //              section headers like "Intro D" / "Outro G")
  const accept =
    ratio >= CHORD_LINE_RATIO_MIN ||
    chordCount >= CHORD_LINE_MIN_COUNT ||
    (chordCount >= 1 && tokens.length <= SHORT_LINE_MAX_SUBSTANTIVE);
  if (!accept) return [];

  const out: ChordToken[] = [];
  for (const t of tokens) {
    if (t.snapped === null) continue;
    out.push({
      // Use the snapped canonical name — transposition operates on a
      // clean chord symbol regardless of what Tesseract actually wrote.
      text: t.snapped,
      raw: t.word.text,
      // Bboxes come back from Tesseract in the upscaled-canvas coordinate
      // space (see preprocessForOCR's OCR_UPSCALE). Divide back to the
      // image's natural pixel coordinates here so the overlay can render
      // against `img.naturalWidth/Height` without knowing about OCR.
      bbox: {
        x0: t.word.bbox.x0 / bboxScale,
        y0: t.word.bbox.y0 / bboxScale,
        x1: t.word.bbox.x1 / bboxScale,
        y1: t.word.bbox.y1 / bboxScale,
      },
      confidence: t.word.confidence,
    });
  }
  return out;
}

/** Free the worker process. Useful in tests or low-memory situations. */
export async function disposeOCR(): Promise<void> {
  if (!workerPromise) return;
  try {
    const w = await workerPromise;
    await w.terminate();
  } catch {
    /* swallow */
  }
  workerPromise = null;
}

// Threshold below which a pixel is treated as ink. Empirically the
// "chord tabs" watermark sits at luminance ~200 (very light gray) while
// the bold chord glyphs are <50. Anywhere in 80-160 cleans up the
// watermark without eating into anti-aliased glyph edges.
const BINARIZE_THRESHOLD = 140;

/**
 * Returns a black/white canvas the same dimensions as the source image,
 * with every pixel above `BINARIZE_THRESHOLD` mapped to pure white and
 * everything else to pure black. Used to denoise chord sheets before OCR
 * — removes background watermarks / cursive stamps that otherwise produce
 * lyric-shaped noise tokens.
 *
 * Returns null on any failure (no 2D context, tainted canvas, etc.) so
 * the caller can fall back to the raw image. We don't request CORS-
 * enabled reading here because the `<img>` is loaded with
 * `crossOrigin="anonymous"` against the R2 ACAO: * header — by the time
 * this function is called the canvas is paintable and `getImageData`
 * succeeds.
 */
// Tesseract's accuracy on bold chord glyphs at the source images' native
// resolution (typically 800-1000 px wide) is OK on big text but unreliable
// on smaller / thinner ones — the "Intro / D / G / Em / A /" header rows
// sometimes get dropped entirely. Upscaling the source bitmap before
// recognition (with high-quality smoothing, then immediately binarised
// hard so we don't introduce gray edges) gives the recogniser more pixel
// data per glyph and dramatically improves recall on those rows. Bbox
// coordinates returned by Tesseract are in the UPSCALED canvas space, so
// the caller must divide by `scale` to map back to natural-image coords.
const OCR_UPSCALE = 2;

function preprocessForOCR(
  imageEl: HTMLImageElement,
): { canvas: HTMLCanvasElement; scale: number } | null {
  if (!imageEl.naturalWidth || !imageEl.naturalHeight) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = imageEl.naturalWidth * OCR_UPSCALE;
    canvas.height = imageEl.naturalHeight * OCR_UPSCALE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(imageEl, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      // Rec.601 luminance — fast and matches how chord-sheet greyscale
      // exports were rendered.
      const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const v = y < BINARIZE_THRESHOLD ? 0 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      // alpha left alone
    }
    ctx.putImageData(img, 0, 0);
    return { canvas, scale: OCR_UPSCALE };
  } catch {
    return null;
  }
}

async function loadFromCache(songId: number): Promise<OCRResult | null> {
  try {
    const v = await idbGet(CACHE_PREFIX + songId);
    if (!v || typeof v !== "object") return null;
    return v as OCRResult;
  } catch {
    return null;
  }
}

async function saveToCache(songId: number, result: OCRResult): Promise<void> {
  try {
    await idbSet(CACHE_PREFIX + songId, result);
  } catch {
    /* IndexedDB unavailable / quota exceeded — drop silently */
  }
}

/**
 * Run OCR on a chord-sheet image, returning the detected chord tokens with
 * their bounding boxes in the image's natural pixel coordinates. Caches the
 * result per `songId` so the second open of the same song skips OCR.
 *
 * Callers should treat this as a slow operation on first invocation per
 * song (5–30 s depending on device). It's safe to call multiple times in
 * parallel for the same song — the cache lookup runs first and short-
 * circuits.
 */
export async function runChordOCR(
  songId: number,
  imageEl: HTMLImageElement,
): Promise<OCRResult> {
  const cached = await loadFromCache(songId);
  if (cached && cached.ocrVersion === OCR_VERSION) return cached;

  const started = performance.now();
  const worker = await getWorker();
  // Pre-process the source bitmap before handing it to Tesseract: convert
  // to a hard-thresholded black/white canvas, which wipes the cursive
  // "chord tabs" watermark and the diagonal gray "chordtabs.in.th" stripe
  // that confuse the recogniser. Bold chord glyphs survive the threshold
  // cleanly; the OCR sees a much cleaner page and stops emitting nonsense
  // tokens like "Big" or "Down" that previously bled into the histogram.
  const preprocessed = preprocessForOCR(imageEl);
  const ocrInput = preprocessed?.canvas ?? imageEl;
  const bboxScale = preprocessed?.scale ?? 1;
  // Request `blocks: true` because we need the per-word bbox tree, not
  // just the concatenated text.
  const { data } = await worker.recognize(ocrInput, {}, { blocks: true });

  // Walk the page line-by-line. We only accept chord tokens from lines
  // that look like chord rows (mostly chord-shaped tokens) — lyric lines
  // get rejected wholesale even if they contain a coincidentally-valid
  // chord shape such as the standalone "Eb" inside "Tune down ½ tone to
  // Eb" tuning hints.
  const chords: ChordToken[] = [];
  for (const line of eachLine(data as unknown as TesseractPage)) {
    chords.push(...extractChordsFromLine(line, bboxScale));
  }

  const result: OCRResult = {
    chords,
    width: imageEl.naturalWidth,
    height: imageEl.naturalHeight,
    durationMs: Math.round(performance.now() - started),
    ocrVersion: OCR_VERSION,
  };
  await saveToCache(songId, result);
  return result;
}
