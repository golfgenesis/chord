// Estimate the most likely key (tonic + mode) for a list of detected chord
// symbols. The previous version of this file counted root-pitch frequency
// only and ignored chord QUALITY — that fell over on a textbook D-major
// progression like { D, Bm, F#m, G, A }, because if the OCR happens to
// emit slightly more Bm than D the algorithm would claim "B" was the
// tonic. Musically those five chords are the I-vi-iii-IV-V of D major;
// they're identically diatonic to B minor (D's relative minor), but the
// tonic is D, not B.
//
// The fix is to score every candidate key (all 12 majors AND all 12
// minors = 24 keys total) against the chord list using a diatonic match
// that REQUIRES the chord quality to agree with the expected scale
// degree. D-major-vs-B-minor still scores the same on a clean D-major
// chord list — they share the same notes — but the tiebreakers below
// pick the right one:
//
//   1. The key whose tonic+quality matches the FIRST chord wins. Chord
//      sheets overwhelmingly open on the tonic chord.
//   2. Else the key whose tonic is the most-frequent chord root wins.
//   3. Else prefer major over minor (most pop / Thai-pop songs are major).

import { transposeChord } from "./musicTheory";

const LETTER_SEMITONE: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

type Quality = "maj" | "min" | "dim";

interface ParsedChord {
  root: number;
  quality: Quality;
}

function parseChord(chord: string): ParsedChord | null {
  const m = chord.match(/^([A-G])([#♯b♭]?)(.*?)(?:\/([A-G])([#♯b♭]?))?$/);
  if (!m) return null;
  const letter = m[1];
  const acc = m[2];
  const suffix = (m[3] ?? "").trim();
  const base = LETTER_SEMITONE[letter];
  if (base === undefined) return null;
  let root = base;
  if (acc === "#" || acc === "♯") root += 1;
  else if (acc === "b" || acc === "♭") root -= 1;
  root = ((root % 12) + 12) % 12;

  // Quality detection. Order matters: "maj" / "M7" must be checked BEFORE
  // the bare-"m" minor check, otherwise "maj7" gets misclassified as minor.
  // We also explicitly recognise "M" + digit (CM7) as major-7-flavoured
  // rather than minor.
  const s = suffix.toLowerCase();
  let quality: Quality = "maj";
  if (s.startsWith("dim") || s === "°" || s === "ø" || s.startsWith("ø")) {
    quality = "dim";
  } else if (s.startsWith("m7b5")) {
    quality = "dim"; // m7b5 / half-diminished — sits between min and dim, but
                      // closer to dim for key-fit purposes
  } else if (s.startsWith("maj") || s.startsWith("ma7")) {
    quality = "maj";
  } else if (s.startsWith("m")) {
    quality = "min";
  } else if (suffix.startsWith("M") && /\d/.test(suffix)) {
    // "CM7" capital-M-with-digit = major 7
    quality = "maj";
  }
  return { root, quality };
}

// Scale-degree offsets and expected triad qualities for the two modes we
// support. Index = scale degree (0-based: I/i, ii, iii, …).
const MAJOR_OFFSETS = [0, 2, 4, 5, 7, 9, 11] as const;
const MAJOR_QUALITIES: ReadonlyArray<Quality> = [
  "maj", "min", "min", "maj", "maj", "min", "dim",
];
const MINOR_OFFSETS = [0, 2, 3, 5, 7, 8, 10] as const;
const MINOR_QUALITIES: ReadonlyArray<Quality> = [
  // Natural minor: i, ii°, III, iv, v, VI, VII. We swap v→V (maj) for the
  // V degree because Thai/pop songs in minor keys almost always use the
  // harmonic-minor dominant. Without this, real minor-key songs score
  // poorly on their own V chord.
  "min", "dim", "maj", "min", "maj", "maj", "maj",
];

function diatonicScore(chord: ParsedChord, tonic: number, mode: "major" | "minor"): number {
  const offsets = mode === "major" ? MAJOR_OFFSETS : MINOR_OFFSETS;
  const qualities = mode === "major" ? MAJOR_QUALITIES : MINOR_QUALITIES;
  const offset = (chord.root - tonic + 12) % 12;
  const idx = offsets.indexOf(offset as never);
  if (idx < 0) return 0; // root not in the scale at all
  const expected = qualities[idx];
  if (expected === chord.quality) return 1.0;
  // Root is in scale but quality disagrees — common when a chart borrows a
  // chord (e.g., parallel minor in a major-key song). Half credit so the
  // borrowing doesn't kill the fit ratio entirely.
  return 0.5;
}

export interface KeyEstimate {
  tonic: number;        // 0..11
  mode: "major" | "minor";
  /** 0..1 — fraction of chords whose root + quality fit the chosen key. */
  confidence: number;
  /** Back-compat alias kept for the chip-tier code that still reads it. */
  correlation: number;
}

/**
 * Find the most likely key for a list of chord symbols. Returns null if
 * the input is empty or no chords parsed.
 */
export function detectKey(chords: string[]): KeyEstimate | null {
  if (chords.length === 0) return null;
  const parsed: ParsedChord[] = [];
  for (const c of chords) {
    const p = parseChord(c);
    if (p) parsed.push(p);
  }
  if (parsed.length === 0) return null;

  // Score every candidate (12 majors + 12 minors).
  type Cand = { tonic: number; mode: "major" | "minor"; score: number };
  const cands: Cand[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ["major", "minor"] as const) {
      let s = 0;
      for (const p of parsed) s += diatonicScore(p, tonic, mode);
      cands.push({ tonic, mode, score: s });
    }
  }

  // Find the best score so we can locate every key tied at that score.
  // Two-pass keeps the tiebreaker logic separate from the scoring math.
  let bestScore = -Infinity;
  for (const c of cands) if (c.score > bestScore) bestScore = c.score;
  const EPS = 0.01;
  const tied = cands.filter((c) => Math.abs(c.score - bestScore) < EPS);

  // Frequency of each root — used as one of the tiebreakers below.
  const rootFreq = new Array(12).fill(0);
  for (const p of parsed) rootFreq[p.root]++;

  const firstChord = parsed[0];

  // Apply tiebreakers, in descending priority.
  tied.sort((a, b) => {
    const aFirst =
      a.tonic === firstChord.root &&
      (a.mode === "minor") === (firstChord.quality === "min");
    const bFirst =
      b.tonic === firstChord.root &&
      (b.mode === "minor") === (firstChord.quality === "min");
    if (aFirst !== bFirst) return aFirst ? -1 : 1;

    // Then: tonic equals the most-frequent root.
    const aFreq = rootFreq[a.tonic];
    const bFreq = rootFreq[b.tonic];
    if (aFreq !== bFreq) return bFreq - aFreq;

    // Then: prefer major (most pop songs).
    if (a.mode !== b.mode) return a.mode === "major" ? -1 : 1;

    return 0;
  });

  const winner = tied[0];
  const confidence = Math.min(1, winner.score / parsed.length);
  return {
    tonic: winner.tonic,
    mode: winner.mode,
    confidence,
    correlation: confidence,
  };
}

/**
 * Convenience wrapper: given a list of original chords AND a transpose
 * delta (in semitones), return the transposed chord list using the target
 * key's preferred enharmonic spelling.
 */
export function transposeAll(
  chords: string[],
  delta: number,
  preferFlats: boolean,
): string[] {
  return chords.map((c) => transposeChord(c, delta, preferFlats));
}
