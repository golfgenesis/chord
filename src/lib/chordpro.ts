// ChordPro-style chord-sheet model + parser.
//
// This is the text format that REPLACES the chord-sheet image. A song is
// stored as plain text where chords are inline-bracketed at the syllable
// they sit above:
//
//   {key: C}
//   {note: Tune Down ½ tone to Eb}
//
//   Intro: [C] / [G] / [C] / [G]   (×2)
//
//   [C]ออกจาก[G]ชีวิตฉันไปได้ไหม [Am]อย่าอยู่อย่าเสียเวลากับฉันได้ไหม
//
// Why bracket EVERY chord (even on the Intro / Instru rows) instead of
// leaving bare "C / G /" tokens: it makes parsing one unambiguous rule —
// anything inside [...] is a chord, everything else is literal text. There's
// no "is this 'C' a chord or the English word 'C'" guessing, and transposition
// is a pure pass over the bracketed tokens. The offline extractor (vision
// model → ChordPro) emits this format; the client only ever parses it.
//
// Transposition is intentionally NOT done here — the renderer applies it at
// display time via musicTheory.transposeChord so the same parsed model serves
// every target key without re-parsing.

import { relativeMajorTonic, type Semitone } from "./musicTheory";

/** One chord + the lyric text that follows it (chord sits above text[0]). */
export interface ChordSeg {
  /** Canonical chord symbol, or "" for a lyric run with no chord above it. */
  chord: string;
  text: string;
}

/** A literal-vs-chord token, used to render the inline Intro / Instru rows. */
export type RowToken =
  | { type: "text"; value: string }
  | { type: "chord"; value: string };

export type SheetLine =
  // A lyric line: chords render as small labels ABOVE their syllable.
  | { kind: "lyric"; segments: ChordSeg[] }
  // A chord-only row (Intro / Instru / section headers): chords render
  // inline on a single mono row, interleaved with the literal separators
  // and labels exactly as written.
  | { kind: "chords"; tokens: RowToken[] }
  // Vertical breathing room between blocks.
  | { kind: "blank" };

export interface SheetMeta {
  /** Raw value of {key: …} if present (e.g. "C", "Am", "Eb"). */
  key?: string;
  /** Freeform note banner — e.g. "Tune Down ½ tone to Eb". */
  note?: string;
  title?: string;
  artist?: string;
}

export interface ParsedSheet {
  lines: SheetLine[];
  meta: SheetMeta;
  /** Every chord symbol on the sheet, in reading order — feed to detectKey. */
  chords: string[];
  /**
   * Source key as a MAJOR-tonic pitch class (0..11), mapped from {key: …}
   * via relative-major so it lines up with the 12-key picker. null when the
   * sheet declares no key (caller falls back to detectKey).
   */
  sourceKey: Semitone | null;
}

// Section labels we recognise on chord-only rows. Mirrors the set in
// chordOCR.ts so the two pipelines classify the same rows the same way.
const SECTION_LABEL_RE =
  /\b(intro|verse|chorus|prechorus|bridge|outro|ending|coda|solo|interlude|instru(?:mental)?|hook|tag|riff)\b/gi;

const LETTER_SEMITONE: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

// Parse a key directive value ("C", "Am", "Bb", "F#m") → tonic + mode.
function parseKeyValue(raw: string): { tonic: Semitone; mode: "major" | "minor" } | null {
  const m = raw.trim().match(/^([A-G])([#♯b♭]?)\s*(m|min|minor)?$/i);
  if (!m) return null;
  const base = LETTER_SEMITONE[m[1].toUpperCase()];
  if (base === undefined) return null;
  let semi = base;
  if (m[2] === "#" || m[2] === "♯") semi += 1;
  else if (m[2] === "b" || m[2] === "♭") semi -= 1;
  semi = ((semi % 12) + 12) % 12;
  const mode = m[3] ? "minor" : "major";
  return { tonic: semi, mode };
}

// Split a raw line into literal-text / [chord] tokens in order.
function tokenizeLine(raw: string): RowToken[] {
  const out: RowToken[] = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (m.index > last) out.push({ type: "text", value: raw.slice(last, m.index) });
    out.push({ type: "chord", value: m[1].trim() });
    last = re.lastIndex;
  }
  if (last < raw.length) out.push({ type: "text", value: raw.slice(last) });
  return out;
}

// A line is "chord-only" (Intro / Instru / section header) when, after
// removing the bracketed chords, parenthetical annotations, section labels,
// separators, counts and markers, NOTHING meaningful is left. Lyric lines
// keep their Thai/Latin words and fail this test.
function isChordOnlyLine(raw: string): boolean {
  const rest = raw
    .replace(/\[[^\]]*\]/g, " ") // bracketed chords
    .replace(/\([^)]*\)/g, " ") // (×2), (2 Times), (G)
    .replace(SECTION_LABEL_RE, " ") // Intro / Instru / …
    .replace(/[/|×x*:.,\-–—\d]/gi, " ") // separators, counts, markers
    .trim();
  return rest.length === 0;
}

// Collapse a token list into chord-above-syllable segments. A chord token
// opens a new segment; the text that follows it is the segment body. Text
// before the first chord becomes a chord-less leading segment.
function toSegments(tokens: RowToken[]): ChordSeg[] {
  const segs: ChordSeg[] = [];
  let cur: ChordSeg | null = null;
  for (const t of tokens) {
    if (t.type === "chord") {
      if (cur) segs.push(cur);
      cur = { chord: t.value, text: "" };
    } else if (cur) {
      cur.text += t.value;
    } else {
      segs.push({ chord: "", text: t.value });
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

const DIRECTIVE_RE = /^\{\s*([a-z_]+)\s*:\s*([^}]*)\}\s*$/i;

/**
 * Parse a ChordPro-style source string into a render-ready model. Pure and
 * cheap — safe to call inside a useMemo. Unknown directives are ignored;
 * malformed lines degrade to plain lyric lines rather than throwing.
 */
export function parseChordpro(src: string): ParsedSheet {
  const meta: SheetMeta = {};
  const lines: SheetLine[] = [];
  const chords: string[] = [];

  for (const rawLine of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+$/, ""); // trim trailing ws, keep leading

    const dir = line.match(DIRECTIVE_RE);
    if (dir) {
      const name = dir[1].toLowerCase();
      const value = dir[2].trim();
      if (name === "key") meta.key = value;
      else if (name === "note" || name === "comment" || name === "c") meta.note = value;
      else if (name === "title" || name === "t") meta.title = value;
      else if (name === "artist" || name === "subtitle" || name === "st") meta.artist = value;
      continue;
    }

    if (line.trim() === "") {
      lines.push({ kind: "blank" });
      continue;
    }

    const tokens = tokenizeLine(line);
    for (const t of tokens) if (t.type === "chord" && t.value) chords.push(t.value);

    if (isChordOnlyLine(line)) {
      lines.push({ kind: "chords", tokens });
    } else {
      lines.push({ kind: "lyric", segments: toSegments(tokens) });
    }
  }

  let sourceKey: Semitone | null = null;
  if (meta.key) {
    const k = parseKeyValue(meta.key);
    if (k) sourceKey = relativeMajorTonic(k.tonic, k.mode);
  }

  return { lines, meta, chords, sourceKey };
}
