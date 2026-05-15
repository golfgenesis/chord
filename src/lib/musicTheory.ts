// Music-theory primitives for transposition.
//
// We treat 12 pitch classes as integers 0..11 (C=0, C#=1, ..., B=11). The UI
// lets the user pick a "from" key and a "to" key; transposition is just the
// signed difference between those two pitch classes applied to each chord's
// root (and bass note, for slash chords). Chord quality / suffix is preserved
// verbatim — m, 7, sus4, maj7, dim, add9, b5, #11, etc. all pass through
// unchanged because they describe intervals relative to the root, not the root
// itself.

export const NOTE_NAMES_SHARP = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

export const NOTE_NAMES_FLAT = [
  "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
] as const;

// Which target keys traditionally read with flats (one or more flats in the
// signature). Spellings match the diatonic-chord convention table that
// musicians read by (e.g. Key Bb → Bb, Cm, Dm, Eb, F, Gm, Adim — flats; Key
// B → B, C#m, D#m, E, F#, G#m, A#dim — sharps). For F# / Gb the spelling is
// a coin-flip in theory, but the key picker chip shows "F#" so we pick
// sharps to keep the chip label consistent with the rendered chord names.
const PREFER_FLATS_BY_TARGET = [
  false, // C  — no accidentals
  true,  // Db — 5 flats
  false, // D  — 2 sharps
  true,  // Eb — 3 flats
  false, // E  — 4 sharps
  true,  // F  — 1 flat
  false, // F# — 6 sharps (chip label shows "F#", so render sharps too)
  false, // G  — 1 sharp
  true,  // Ab — 4 flats
  false, // A  — 3 sharps
  true,  // Bb — 2 flats
  false, // B  — 5 sharps
] as const;

const LETTER_SEMITONE: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

export type Semitone = number; // 0..11

export function preferFlatsForKey(target: Semitone): boolean {
  return PREFER_FLATS_BY_TARGET[((target % 12) + 12) % 12];
}

// Map a detected tonic+mode to the major-key tonic that shares the same key
// signature. Em → G, Am → C, Bm → D, … . The key picker UI only exposes the
// 12 major-key labels, so if detection lands on a minor mode we surface its
// relative major instead of mislabelling the song (e.g. showing "E" for a
// song actually in Em).
export function relativeMajorTonic(tonic: Semitone, mode: "major" | "minor"): Semitone {
  if (mode === "major") return ((tonic % 12) + 12) % 12;
  return ((tonic + 3) % 12 + 12) % 12;
}

export function noteName(semi: Semitone, preferFlats: boolean): string {
  const idx = ((semi % 12) + 12) % 12;
  return preferFlats ? NOTE_NAMES_FLAT[idx] : NOTE_NAMES_SHARP[idx];
}

// Display label for the key dropdowns. Always shows both enharmonics for the
// 5 black-key roots so the user can recognise whichever spelling appears in
// their chord chart.
export function keyLabel(semi: Semitone): string {
  const sharp = NOTE_NAMES_SHARP[semi];
  const flat = NOTE_NAMES_FLAT[semi];
  return sharp === flat ? sharp : `${sharp} / ${flat}`;
}

// Parse the leading note token of a chord-part string. Returns the semitone
// pitch class of the root and the length of the consumed prefix, or null if
// the string doesn't start with a valid note letter.
//
// Accepts ASCII (#, b) and Unicode (♯, ♭) accidentals. Treats the FIRST
// character after the letter as an accidental ONLY if it's actually one — so
// "Bm7" parses as B + suffix "m7", while "Bb" parses as B♭ + suffix "".
function parseRoot(part: string): { semi: Semitone; consumed: number } | null {
  if (!part) return null;
  const letter = part[0];
  const base = LETTER_SEMITONE[letter];
  if (base === undefined) return null;
  let semi = base;
  let consumed = 1;
  const next = part[1];
  if (next === "#" || next === "♯") {
    semi += 1;
    consumed = 2;
  } else if (next === "b" || next === "♭") {
    semi -= 1;
    consumed = 2;
  }
  semi = ((semi % 12) + 12) % 12;
  return { semi, consumed };
}

// Transpose a chord part (e.g. "Am7", "F#sus4", "Bb") by `delta` semitones.
// Returns null if the input doesn't start with a recognisable note letter —
// the caller should fall back to the original string in that case.
function transposePart(part: string, delta: number, preferFlats: boolean): string | null {
  const root = parseRoot(part);
  if (!root) return null;
  const newSemi = ((root.semi + delta) % 12 + 12) % 12;
  return noteName(newSemi, preferFlats) + part.slice(root.consumed);
}

/**
 * Transpose a chord symbol by `delta` semitones (can be negative, can be any
 * integer — wraps modulo 12). Preserves the suffix verbatim and handles
 * slash chords by transposing both root and bass.
 *
 * If the input doesn't start with a valid note letter, returns the input
 * unchanged. This is intentional: we'd rather render the user's literal
 * text than mangle a chord we don't understand.
 */
export function transposeChord(chord: string, delta: number, preferFlats: boolean): string {
  const trimmed = chord.trim();
  if (!trimmed) return chord;
  if (delta === 0) return chord;
  const parts = trimmed.split("/");
  const out: string[] = [];
  for (const p of parts) {
    const t = transposePart(p, delta, preferFlats);
    if (t === null) return chord; // bail — return original if any part fails
    out.push(t);
  }
  return out.join("/");
}

// Roman-numeral quality of each diatonic triad in a major key, paired with
// the offset from the tonic in semitones. The "°" on vii° tells the UI to
// render that chord with a diminished symbol — diatonic transposition keeps
// the quality intact, so a I→I, ii→ii, …, vii°→vii° mapping always holds.
export const DIATONIC_DEGREES: ReadonlyArray<{
  roman: string;
  semitoneOffset: number;
  quality: "maj" | "min" | "dim";
}> = [
  { roman: "I",   semitoneOffset: 0,  quality: "maj" },
  { roman: "ii",  semitoneOffset: 2,  quality: "min" },
  { roman: "iii", semitoneOffset: 4,  quality: "min" },
  { roman: "IV",  semitoneOffset: 5,  quality: "maj" },
  { roman: "V",   semitoneOffset: 7,  quality: "maj" },
  { roman: "vi",  semitoneOffset: 9,  quality: "min" },
  { roman: "vii°", semitoneOffset: 11, quality: "dim" },
];

export function diatonicChordName(
  tonic: Semitone,
  degreeIndex: number,
  preferFlats: boolean,
): string {
  const d = DIATONIC_DEGREES[degreeIndex];
  const name = noteName(tonic + d.semitoneOffset, preferFlats);
  if (d.quality === "min") return name + "m";
  if (d.quality === "dim") return name + "°";
  return name;
}
