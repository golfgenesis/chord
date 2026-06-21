import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ParsedSheet, ChordSeg } from "../lib/chordpro";
import { preferFlatsForKey, transposeChord } from "../lib/musicTheory";

// Lyrics: Noto Sans Thai (looped, highly legible) → IBM Plex Sans Thai fallback.
// Chords: Inter (clean, already loaded) bold — easier to read than monospace.
// Both faces are loaded in index.html.
const LYRIC_FONT = '"Noto Sans Thai", "IBM Plex Sans Thai", system-ui, sans-serif';
const CHORD_FONT = '"Inter", system-ui, sans-serif';
// One chord size everywhere (Intro/Instru rows AND the labels above lyrics) so chords
// never look bigger on one line than another.
const CHORD_EM = "0.82em";

// Adaptive vertical gaps. The inter-line spacing is `BASE * var(--gapK)`, and
// `--gapK` is computed per song so the sheet fills the screen WITHOUT scrolling
// when it reasonably can. GAP_MIN is the floor: below this, lines read as
// cramped, so instead of compressing further we let the page scroll.
const GAP_MIN = 0.4;

// Nearest scrollable ancestor — its clientHeight is the height the sheet has to
// fill (in fit mode the sheet sits inside Fullscreen's overflow-y-auto column).
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
    p = p.parentElement;
  }
  return null;
}

interface Props {
  sheet: ParsedSheet;
  fromKey: number;
  toKey: number;
  invert: boolean;
  /**
   * Fit mode (default): every line stays on ONE line like the printed sheet,
   * and the whole sheet scales DOWN uniformly to fit the viewport width — the
   * text replacement for the image's object-contain. When false (the reader /
   * auto-scroll mode) the font stays full-size and long lines wrap instead, so
   * the lyrics are large and legible on a phone.
   */
  fit?: boolean;
}

export function ChordSheet({ sheet, fromKey, toKey, invert, fit = true }: Props) {
  const dRaw = (((toKey - fromKey) % 12) + 12) % 12;
  const signedDelta = dRaw > 6 ? dRaw - 12 : dRaw;
  const preferFlats = preferFlatsForKey(toKey);
  const tx = (chord: string): string =>
    signedDelta === 0 ? chord : transposeChord(chord, signedDelta, preferFlats);

  const ink = invert ? "#f0eef6" : "#0a0a0a";
  const dim = invert ? "#8e88a0" : "#8a8594";

  // Fit-to-width: measure the natural (unscaled, no-wrap) content width and
  // shrink the whole sheet with a transform so the widest line just fits —
  // exactly how the image is letterboxed today. Transform (not font-size)
  // keeps the measurement stable: scaling doesn't change the laid-out width,
  // so there's no measure→resize→measure feedback loop.
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [gapK, setGapK] = useState(1);
  const [boxH, setBoxH] = useState<number | undefined>(undefined);

  // Measurement only ever setState from async callbacks (rAF / ResizeObserver
  // / fonts.ready) — never synchronously in the effect body. When !fit the
  // render ignores `scale`/`boxH`/`gapK` entirely, so there's nothing to reset.
  useLayoutEffect(() => {
    if (!fit) return;
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const measure = () => {
      // 1) Width fit. Content width is gap-independent, but pin --gapK to 1
      //    first so the height reads below are taken at the known extreme.
      inner.style.setProperty("--gapK", "1");
      const natW = inner.scrollWidth;
      const availW = outer.clientWidth;
      const s = natW > availW && natW > 0 ? availW / natW : 1;

      // 2) Vertical gap fit. Sheet height is LINEAR in --gapK (gaps are the
      //    only thing that changes), so measure the two extremes and solve for
      //    the gapK that makes the scaled sheet just fit the scroll viewport.
      //    H(k) = H0 + k*(H1-H0); want H(k)*s + padY <= availH.
      const hFull = inner.scrollHeight; // --gapK = 1
      inner.style.setProperty("--gapK", "0");
      const hTight = inner.scrollHeight; // --gapK = 0 (gaps collapsed)
      const cs = getComputedStyle(outer);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const sp = scrollParentOf(outer);
      const availH = sp ? sp.clientHeight : window.innerHeight;

      let k = 1;
      if (hFull > hTight + 0.5) {
        const want = ((availH - padY) / s - hTight) / (hFull - hTight);
        k = Math.max(GAP_MIN, Math.min(1, want));
      }
      inner.style.setProperty("--gapK", String(k));

      // boxH is the OUTER height (border-box) so it must include the outer's own
      // vertical padding (py-6) — otherwise the scaled inner + padding overflows
      // and `overflow:hidden` clips the last line(s). When the song is still
      // taller than availH at the gap floor, boxH > availH and the parent
      // scrolls — exactly the intended fallback.
      const hPicked = hTight + k * (hFull - hTight);
      setScale(s);
      setGapK(k);
      setBoxH(hPicked * s + padY);
    };
    const raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) fonts.ready.then(measure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fit, sheet]);

  return (
    <div
      ref={outerRef}
      className="mx-auto max-w-3xl px-4 py-6 sm:px-7"
      style={{ overflow: "hidden", height: fit ? boxH : undefined }}
    >
      <div
        ref={innerRef}
        style={{
          color: ink,
          fontFamily: LYRIC_FONT,
          fontSize: "clamp(17px, 2.5vw, 20px)",
          transform: fit ? `scale(${scale})` : undefined,
          transformOrigin: "top left",
          // Let no-wrap lines extend past the box so scrollWidth reflects the
          // true content width to measure against.
          width: fit ? "max-content" : undefined,
          maxWidth: fit ? "none" : undefined,
          // Drives every inter-line gap below. 1 in reader mode (full spacing);
          // the measured fit value when fitting to screen.
          ["--gapK"]: fit ? gapK : 1,
        } as CSSProperties}
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
            return (
              <div
                key={i}
                style={{ height: "calc(1.15em * var(--gapK, 1))" }}
                aria-hidden="true"
              />
            );
          }
          if (line.kind === "chords") {
            return (
              <div
                key={i}
                style={{
                  fontFamily: CHORD_FONT,
                  whiteSpace: fit ? "pre" : "pre-wrap",
                  color: dim,
                  fontSize: CHORD_EM,
                  fontWeight: 600,
                  margin: "calc(0.5em * var(--gapK, 1)) 0 calc(0.3em * var(--gapK, 1))",
                  letterSpacing: "0.01em",
                }}
              >
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
          return (
            <LyricLine key={i} segments={line.segments} tx={tx} ink={ink} fit={fit} />
          );
        })}
      </div>
    </div>
  );
}

/**
 * One lyric line. Each `[chord]text` segment renders as an inline-block COLUMN —
 * the chord stacked above its text. The column's width is `max(chord, text)`, so a
 * chord label WIDER than the word below reserves its own space and pushes the next
 * column right instead of overlapping it (e.g. "G/B" over "ดี"). The chord always
 * stays above its own word, and the lyric still reads continuously because the
 * columns butt together (bottom-aligned baselines). In fit mode the line never
 * wraps; in reader mode it wraps at column (chord) boundaries.
 */
function LyricLine({
  segments,
  tx,
  ink,
  fit,
}: {
  segments: ChordSeg[];
  tx: (c: string) => string;
  ink: string;
  fit: boolean;
}) {
  const hasChord = segments.some((s) => s.chord);
  return (
    <div
      style={{
        // Gaps scale with --gapK so the sheet can tighten to fit the screen.
        // The chord label lives INSIDE the column (block above its word), not in
        // this margin, so compressing the margin never lets a chord collide with
        // the line above — and lineHeight 1.2 keeps the text itself readable.
        margin: hasChord
          ? "calc(0.55em * var(--gapK, 1)) 0 calc(0.14em * var(--gapK, 1))"
          : "calc(0.14em * var(--gapK, 1)) 0",
        whiteSpace: fit ? "nowrap" : "normal",
        wordBreak: "normal",
        lineHeight: 1.2,
      }}
    >
      {segments.map((seg, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            verticalAlign: "bottom",
            whiteSpace: fit ? "pre" : "pre-wrap",
          }}
        >
          {seg.chord && (
            <span
              aria-hidden="true"
              style={{
                display: "block",
                fontFamily: CHORD_FONT,
                fontWeight: 700,
                fontSize: CHORD_EM,
                lineHeight: 1.35,
                color: ink,
                whiteSpace: "nowrap",
                paddingRight: "0.65em", // guarantees a gap to the next chord
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
