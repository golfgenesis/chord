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
const OCR_VERSION = 14;
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

// Whitelist of characters Tesseract is allowed to emit. We pass the full
// English alphabet here — NOT just chord letters — because Tesseract's
// word grouping relies on being able to recognise ALL the glyphs on a
// row. The previous tighter whitelist ("ABCDEFGabcdefgHmajinsudo…") was
// stripping the I/T/R/U letters out of section labels like "Intro" and
// "Instru", which made Tesseract glue the broken label onto the chord
// name beside it ("Intro Dm" → "noDm") so the chord couldn't be matched.
// Letting Tesseract see the labels in full lets it form the right word
// boundaries; the chord-vocabulary snap downstream is what actually
// filters chord tokens from prose, not this whitelist.
const CHORD_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz°#♯b♭/0123456789+-()";

// Single confidence floor for all chord tokens. We previously also had a
// stricter floor for single-letter tokens ("A" / "B" / "D") because they
// double as English filler words — but in practice, Tesseract scores
// single chord letters MUCH lower when they sit next to a slash or
// section label on Intro/Instru rows than when they appear cleanly on
// body chord rows. The two-floor scheme silently dropped half the
// Intro/Instru chord letters. The chord-vocabulary snapper is strict
// enough on its own (length ≤ 2 demands exact vocabulary match, length
// 3+ caps edit distance) that we can lean on it to reject lyric noise
// without a second confidence gate per length tier.
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

export interface ChordSpan {
  text: string;       // chord substring (with slashes stripped from edges)
  startIdx: number;   // start position in original token
  endIdx: number;     // end position (exclusive) in original token
}

/**
 * Locate every chord-like substring inside a single OCR'd word, recording
 * each one's position within the original token so the caller can split
 * the bbox proportionally.
 *
 * Two notations are handled:
 *
 *  - **Glued chord pairs.** "Am7 D7" rendered with narrow spacing comes
 *    out of Tesseract as the single token "Am7D7". We split at the
 *    second [A-G] letter and return both halves.
 *
 *  - **Slash-separated chord sequences.** Intro / Instru rows in chord
 *    sheets often print as "Intro / A / A / A / E / ( 2 Times )", which
 *    Tesseract occasionally glues into a single token "A/A/A/E". When
 *    the token contains TWO OR MORE slashes we treat slashes as chord
 *    separators (not slash-chord-bass markers) and split on each of
 *    them.
 *
 * A single slash in the middle of a token still means slash-chord:
 * "G/B" → one chord with bass B, no split.
 */
export function findChordSpans(token: string): ChordSpan[] {
  if (!token) return [];
  const slashCount = (token.match(/\//g) ?? []).length;
  const slashIsSep = slashCount > 1;

  const spans: ChordSpan[] = [];
  let i = 0;
  while (i < token.length) {
    // Skip until we land on a chord-letter start.
    while (i < token.length) {
      const ch = token[i];
      if (ch >= "A" && ch <= "G") break;
      i++;
    }
    if (i >= token.length) break;

    const startIdx = i;
    i++;
    while (i < token.length) {
      const ch = token[i];
      if (ch >= "A" && ch <= "G") {
        // [A-G] right after "/" is slash-chord bass (keep going) UNLESS
        // we're in slash-as-separator mode, in which case the next [A-G]
        // is a fresh chord.
        if (token[i - 1] === "/" && !slashIsSep) {
          i++;
          continue;
        }
        break;
      }
      if (ch === "/" && slashIsSep) break;
      i++;
    }

    const endIdx = i;
    let text = token.slice(startIdx, endIdx);
    if (text.endsWith("/")) text = text.slice(0, -1);
    spans.push({ text, startIdx, endIdx });

    // In separator mode, consume the slash that ended this chord so the
    // next chord starts right after.
    if (slashIsSep && i < token.length && token[i] === "/") i++;
  }
  return spans;
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
      // PSM SPARSE_TEXT (11): "find text anywhere on the page, no fixed
      // ordering". Chord sheets aren't continuous prose — they're a mix
      // of widely-spaced chord labels, lyric rows, and section headers
      // — and SPARSE_TEXT's per-word geometry stays tightly anchored to
      // the actual ink positions. We briefly experimented with PSM AUTO
      // (3) for its layout analysis, but AUTO regroups words into
      // "blocks/columns" and the bboxes drifted off the underlying
      // glyphs, so the red overlays painted next to (not over) the
      // chord text. Stick with SPARSE_TEXT; coverage gaps are better
      // addressed by snap fuzziness and line-classification fallbacks.
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

interface SnappedChord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

// Try to extract one or more chord matches from a single normalised OCR
// word. Uses `findChordSpans` (which records each candidate's start/end
// position inside the original token) so the source bbox can be sliced
// horizontally and each chord lands on its actual visual position —
// including for slash-separated sequences like "A/A/A/E" where the
// slashes occupy bbox space between chords.
function snapWordMaybeGlued(
  normalized: string,
  confidence: number,
  bbox: { x0: number; y0: number; x1: number; y1: number },
): SnappedChord[] {
  if (confidence < MIN_CONFIDENCE_OVERALL) return [];

  const spans = findChordSpans(normalized);
  if (spans.length > 1) {
    const snaps = spans.map((s) => snapChord(s.text));
    if (snaps.every((s): s is string => s !== null)) {
      // All spans snap — distribute the bbox by character position.
      // Each span knows where in the original token it sits, so the
      // overlay lands on the chord glyph instead of the whitespace /
      // slash between chords.
      const totalLen = normalized.length;
      const width = bbox.x1 - bbox.x0;
      const out: SnappedChord[] = [];
      for (let i = 0; i < spans.length; i++) {
        const startRatio = spans[i].startIdx / totalLen;
        const endRatio = spans[i].endIdx / totalLen;
        out.push({
          text: snaps[i],
          bbox: {
            x0: bbox.x0 + width * startRatio,
            y0: bbox.y0,
            x1: bbox.x0 + width * endRatio,
            y1: bbox.y1,
          },
        });
      }
      return out;
    }
  }

  // Fall back to whole-token snap (or first span if there's only one).
  const whole = snapChord(normalized);
  return whole ? [{ text: whole, bbox }] : [];
}

function extractChordsFromLine(
  line: TesseractLine,
  bboxScale: number,
): ChordToken[] {
  // Per-line classification has been removed. The previous gate (chord-
  // density ratio + bulk count + short-line) was supposed to keep tuning
  // hints like "Tune down ½ tone to Eb" from leaking the Eb in as a chord,
  // but it ALSO rejected Intro / Instru rows whenever Tesseract decided
  // to lump the section label, the slashes and the chord letters together
  // into one structural "line" — exactly the rows the user kept seeing
  // un-transposed. The vocabulary snapper is strict enough on its own
  // (length ≤ 2 demands exact match, length 3+ caps edit distance) that
  // it rejects lyric noise without needing a second per-line gate.
  const out: ChordToken[] = [];
  for (const word of line.words ?? []) {
    const raw = (word.text ?? "").trim();
    if (!raw) continue;
    const normalized = normalizeRaw(raw);
    if (!normalized) continue; // pure punctuation / stripped to empty
    const chords = snapWordMaybeGlued(
      normalized,
      word.confidence ?? 0,
      word.bbox,
    );
    for (const c of chords) {
      out.push({
        // Use the snapped canonical name — transposition operates on a
        // clean chord symbol regardless of what Tesseract actually wrote.
        text: c.text,
        raw: word.text,
        // Bboxes come back from Tesseract in the upscaled-canvas
        // coordinate space (see preprocessForOCR's OCR_UPSCALE). Divide
        // back to the image's natural pixel coordinates here so the
        // overlay can render against `img.naturalWidth/Height` without
        // knowing about OCR. The per-chord bbox is what
        // `snapWordMaybeGlued` produced — already split across the
        // source word's geometry for glued-pair tokens.
        bbox: {
          x0: c.bbox.x0 / bboxScale,
          y0: c.bbox.y0 / bboxScale,
          x1: c.bbox.x1 / bboxScale,
          y1: c.bbox.y1 / bboxScale,
        },
        confidence: word.confidence,
      });
    }
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
