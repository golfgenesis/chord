// Canonical chord vocabulary + fuzzy matcher. Used by the OCR pipeline to
// "snap" raw OCR output (which is noisy on stylised chord fonts and over
// watermarked backgrounds) to a known chord name before we bother running
// transposition. The previous strict-regex filter assumed Tesseract would
// emit clean text; in practice it routinely turns "Emaj7" into "Ernaj7"
// or "G#m" into "G$m", and a regex with no edit-distance tolerance has no
// way to recover the chord underneath.
//
// We don't constrain the vocabulary to "chords diatonic to the user's
// source key" — chord sheets borrow freely (parallel minor, secondary
// dominants, modal interchange) and a too-restrictive set would lose
// real chords. The fuzzy threshold below is tight enough that random
// English words on lyric lines (e.g. "Big", "Down") still get rejected.

const ROOTS_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Flat-spelled enharmonics that show up commonly in chord sheets and need
// to round-trip cleanly through the snapper. We deliberately omit the
// non-traditional flats (Cb, Fb, B#, E#) because they're rare and tend to
// cause false positives.
const ROOTS_FLAT = ["Db", "Eb", "Gb", "Ab", "Bb"];

// Common chord-quality suffixes. We include both "maj7" and "M7" because
// chord sheets use either spelling — picking one as canonical and snapping
// the other to it works fine for transposition (we only care about the
// root pitch class).
const QUALITIES = [
  "",
  "m", "M",
  "5",
  "6", "m6", "69", "6/9",
  "7", "m7", "M7", "maj7",
  "9", "m9", "M9", "maj9",
  "11", "m11", "13", "m13", "maj13",
  "sus", "sus2", "sus4", "7sus4", "9sus4",
  "add9", "add2", "add4", "add11",
  "dim", "dim7", "m7b5", "ø", "ø7",
  "aug", "+", "+7",
  "7b5", "7#5", "7b9", "7#9", "9b5", "9#5", "13#11",
];

let _vocab: Set<string> | null = null;
function getVocab(): Set<string> {
  if (_vocab) return _vocab;
  const s = new Set<string>();
  for (const r of [...ROOTS_SHARP, ...ROOTS_FLAT]) {
    for (const q of QUALITIES) {
      s.add(r + q);
    }
  }
  _vocab = s;
  return s;
}

// Standard 2-row Levenshtein. Inputs are short (≤8 chars in practice) so
// even the naïve allocation pattern is fine. Returns Infinity once a
// known cap is exceeded — saves work on obviously-too-different pairs.
function levenshtein(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > cap) return Infinity;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return Infinity;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Splits a chord-with-bass like "D/F#" into its two parts. Returns null
// if the slash isn't there or the split is malformed.
function splitSlash(s: string): { chord: string; bass: string } | null {
  const idx = s.indexOf("/");
  if (idx <= 0 || idx === s.length - 1) return null;
  return { chord: s.slice(0, idx), bass: s.slice(idx + 1) };
}

// Bass notes after a slash must be a plain note name — no quality. We
// don't snap bass notes (no fuzzy match) because they're short and
// errors would be ambiguous.
function isPlainNote(s: string): boolean {
  return /^[A-G][#♯b♭]?$/.test(s);
}

function snapPlain(token: string): string | null {
  const vocab = getVocab();
  if (vocab.has(token)) return token;

  // Length 1–2 tokens (e.g. "A", "Em") demand an EXACT match — fuzzy
  // matching at this length collides with English filler words like
  // "Be", "Go", "He". Anything that genuinely needs a 1-edit fix at
  // length 2 was probably mis-OCR'd from a longer chord anyway, in
  // which case we'd rather drop it than guess.
  if (token.length <= 2) return null;

  // Length 3+ tokens get an edit-distance tolerance that scales mildly
  // with length: 1 for the 3-char tier (Em7, Asus, etc.) and 2 for the
  // 4+ char tier (Emaj7, m7b5 variants, …).
  const cap = token.length >= 4 ? 2 : 1;
  let best: string | null = null;
  let bestDist = cap + 1;
  for (const c of vocab) {
    if (Math.abs(c.length - token.length) > cap) continue;
    const d = levenshtein(token, c, cap);
    if (d < bestDist) {
      bestDist = d;
      best = c;
      if (d === 0) return best;
    }
  }
  return best;
}

/**
 * Snap an OCR'd token to its closest canonical chord name. Returns null
 * when no plausible chord matches within the edit-distance budget for
 * that length — those tokens should be discarded by the caller.
 *
 * The input should already have leading/trailing punctuation stripped
 * and the leading note letter upper-cased (see `chordOCR.normalizeRaw`).
 *
 * Slash chords are handled by snapping each side independently: the
 * left side goes through full chord snapping; the right side only
 * accepts a bare note name (no quality), with no fuzzy matching.
 */
export function snapChord(token: string): string | null {
  if (!token) return null;
  const slash = splitSlash(token);
  if (slash) {
    const main = snapPlain(slash.chord);
    if (!main) return null;
    if (!isPlainNote(slash.bass)) return null;
    return `${main}/${slash.bass}`;
  }
  return snapPlain(token);
}
