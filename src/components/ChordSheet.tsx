import type { ParsedSheet, ChordSeg } from "../lib/chordpro";
import { preferFlatsForKey, transposeChord } from "../lib/musicTheory";

// Sarabun for the whole sheet: a plain, loop-style (หัวกลม) Thai sans-serif — the
// free, readable equivalent of the Tahoma/TH-Sarabun face the original chordtabs.in.th
// chord-sheet images used. It carries both Thai and Latin glyphs, so lyrics and chord
// names render in one cohesive family that matches the source image. Chords stay
// distinct via weight + accent colour, not a different typeface. Loaded async from
// Google Fonts in index.html; the system stack is the fallback while it streams.
const SHEET_FONT =
  '"Sarabun", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Noto Sans Thai", sans-serif';
const LYRIC_FONT = SHEET_FONT;
const CHORD_FONT = SHEET_FONT;
// One chord size everywhere (Intro/Instru rows AND the labels above lyrics) so chords
// never look bigger on one line than another.
const CHORD_EM = "0.82em";

interface Props {
  sheet: ParsedSheet;
  fromKey: number;
  toKey: number;
  invert: boolean;
}

// Full-size reader layout: the lyrics stay large and legible on a phone, long lines
// wrap at chord-column boundaries, and the Fullscreen container scrolls vertically.
export function ChordSheet({ sheet, fromKey, toKey, invert }: Props) {
  const dRaw = (((toKey - fromKey) % 12) + 12) % 12;
  const signedDelta = dRaw > 6 ? dRaw - 12 : dRaw;
  const preferFlats = preferFlatsForKey(toKey);
  const tx = (chord: string): string =>
    signedDelta === 0 ? chord : transposeChord(chord, signedDelta, preferFlats);

  const ink = invert ? "#f0eef6" : "#0a0a0a";
  const dim = invert ? "#8e88a0" : "#8a8594";

  return (
    <div
      className="px-3 py-2 sm:px-5"
      style={{ overflow: "hidden" }}
    >
      <div
        style={{
          color: ink,
          fontFamily: LYRIC_FONT,
          fontSize: "clamp(17px, 2.5vw, 20px)",
        }}
      >
        {sheet.meta.note && (
          <p
            className="mb-5 inline-block rounded-md px-2.5 py-1 font-mono text-[12.5px] sm:text-[13px]"
            style={{
              color: invert ? "#fcd34d" : "#b45309",
              background: invert ? "rgba(252,211,77,0.12)" : "rgba(180,83,9,0.08)",
            }}
          >
            {sheet.meta.note}
          </p>
        )}

        {sheet.lines.map((line, i) => {
          if (line.kind === "blank") {
            return <div key={i} style={{ height: "0.6em" }} aria-hidden="true" />;
          }
          if (line.kind === "chords") {
            return (
              <div
                key={i}
                style={{
                  fontFamily: CHORD_FONT,
                  whiteSpace: "pre-wrap",
                  color: dim,
                  fontSize: CHORD_EM,
                  fontWeight: 600,
                  // Tight: an Intro/Instru/Outro block's own rows sit close together (the blank
                  // line that used to separate them is gone — see emit_instr). Block-to-content
                  // separation comes from the surrounding blank lines, not this margin.
                  margin: "0.16em 0",
                  letterSpacing: "0.01em",
                }}
              >
                {line.indent && (
                  // Invisible copy of the lead row's label ("Intro / ") — same font, size
                  // and weight as the real prefix above, so this continuation row's first
                  // chord lands EXACTLY under the lead row's first chord (font-independent,
                  // no space-counting). visibility:hidden keeps the width but hides the ink.
                  <span aria-hidden="true" style={{ visibility: "hidden" }}>
                    {line.indent}
                  </span>
                )}
                {line.tokens.map((t, j) =>
                  t.type === "chord" ? (
                    <span key={j} style={{ color: ink, fontWeight: 700 }}>
                      {tx(t.value)}
                    </span>
                  ) : (
                    <span key={j}>{t.value}</span>
                  ),
                )}
              </div>
            );
          }
          return <LyricLine key={i} segments={line.segments} tx={tx} ink={ink} />;
        })}
      </div>
    </div>
  );
}

/**
 * One lyric line, rendered chord-over-lyric exactly like the original chord-sheet
 * image. Each `[chord]text` segment is an inline-block whose WIDTH equals the lyric
 * text only — the chord is absolutely positioned in a reserved top band (`paddingTop`)
 * directly above its own syllable, so a chord WIDER than the word below it (e.g.
 * "G/B" over "ดี") overflows to the right WITHOUT pushing the lyric apart. The lyric
 * therefore flows continuously like printed text, while every chord still lands right
 * above the syllable it belongs to. The reserved top band is a per-segment padding
 * (not a one-off line margin) so it travels with each visual row when a long line
 * wraps. Lines wrap at segment (chord) boundaries.
 */
// Height of the chord band reserved above the lyric (≈ chord cap-height + breathing
// room). Tuned to match the gap on the source sheets without crowding the line above.
const CHORD_BAND = "1.45em";
function LyricLine({
  segments,
  tx,
  ink,
}: {
  segments: ChordSeg[];
  tx: (c: string) => string;
  ink: string;
}) {
  const hasChord = segments.some((s) => s.chord);
  // Leading whitespace on a line is a deliberate section indent (the * / ** verses,
  // etc.). Render it as a block-level left pad — NOT as literal leading spaces — so
  // it indents EVERY wrapped row equally; left as inline spaces it only indented the
  // first visual row, leaving wrapped continuations jutting out to the far left.
  // ~0.5ch ≈ one source space in a proportional font.
  const lead =
    segments[0] && !segments[0].chord
      ? segments[0].text.match(/^ +/)?.[0].length ?? 0
      : 0;
  const segs = lead
    ? segments.map((s, i) => (i === 0 ? { ...s, text: s.text.replace(/^ +/, "") } : s))
    : segments;
  return (
    <div
      style={{
        // The chord label lives INSIDE the column (block above its word), not in this
        // margin, so a chord never collides with the line above — and lineHeight 1.2
        // keeps the text itself readable.
        margin: hasChord ? "0.3em 0 0.1em" : "0.1em 0",
        paddingLeft: lead ? `${lead * 0.5}ch` : undefined,
        whiteSpace: "normal",
        wordBreak: "normal",
        lineHeight: 1.2,
      }}
    >
      {segs.map((seg, i) => (
        <span
          key={i}
          style={{
            position: "relative",
            display: "inline-block",
            verticalAlign: "bottom",
            whiteSpace: "pre-wrap",
            // Reserve the chord band on EVERY segment of a chorded line (even the
            // chord-less ones) so the lyric baseline stays level across the line and
            // the band repeats above each row when the line wraps.
            paddingTop: hasChord ? CHORD_BAND : undefined,
          }}
        >
          {seg.chord && (
            <span
              aria-hidden="true"
              style={{
                // Absolute → the chord sits in the reserved band above its syllable
                // and DOES NOT add to the segment's width, so the lyric never gets
                // pushed apart. A wider-than-syllable chord overflows right (over the
                // empty band above the next syllable), just like the source sheet.
                position: "absolute",
                top: 0,
                left: 0,
                fontFamily: CHORD_FONT,
                fontWeight: 700,
                fontSize: CHORD_EM,
                lineHeight: 1.35,
                color: ink,
                whiteSpace: "nowrap",
                paddingRight: "0.6em", // min gap before the next chord if they crowd
              }}
            >
              {tx(seg.chord)}
            </span>
          )}
          <span style={{ display: "block" }}>{seg.text || " "}</span>
        </span>
      ))}
    </div>
  );
}
