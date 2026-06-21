import { useEffect, useLayoutEffect, useState } from "react";
import type { OCRResult } from "../lib/chordOCR";
import { preferFlatsForKey, transposeChord } from "../lib/musicTheory";

interface Props {
  result: OCRResult;
  imgEl: HTMLImageElement | null;
  fromKey: number;
  toKey: number;
  invert: boolean;
  // When true, draws an outline + label around EVERY detected chord token
  // (not just transposed ones) so the user can verify what Tesseract
  // actually read and where it placed each bbox. Useful for debugging
  // sections that look "untransposed" — if a chord isn't outlined here,
  // OCR didn't see it; if it IS outlined but the wrong name, snap is off.
  debug?: boolean;
}

interface Layout {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Renders transposed chord labels positioned over the detected chord
 * locations on the chord-sheet image. The overlay sits in the same flex
 * container as the `<img>`, so it shares the container's bounding box; the
 * positions are computed by mapping the OCR's natural-pixel bboxes through
 * the `object-contain` scale + letterbox offset.
 *
 * Pointer-events are off on the wrapper so taps fall through to the image
 * (which is responsible for click-to-close fullscreen). The per-chord boxes
 * also don't intercept clicks for the same reason.
 */
export function ChordOverlay({
  result,
  imgEl,
  fromKey,
  toKey,
  invert,
  debug,
}: Props) {
  const [layout, setLayout] = useState<Layout | null>(null);

  // Compute layout (scale + letterbox offsets) whenever the container size
  // changes or the image element swaps.
  //
  // We size against the `<img>` element's OWN client box rather than its
  // parent's. The parent carries a `padding-bottom: var(--safe-bottom)`
  // for the iOS / iPadOS home-indicator inset (≈34 px on iPad), and
  // `parent.clientHeight` INCLUDES that padding even though the image
  // only fills the parent's content box above it. Using parent dimensions
  // overshoots the letterbox offsetY by half the inset, which is why the
  // red overlays drifted down past the actual chord glyphs on iPad. The
  // image element itself reports the box the bitmap is actually drawn
  // into.
  useLayoutEffect(() => {
    if (!imgEl) return;

    const compute = () => {
      const cw = imgEl.clientWidth;
      const ch = imgEl.clientHeight;
      const nw = imgEl.naturalWidth;
      const nh = imgEl.naturalHeight;
      if (!cw || !ch || !nw || !nh) {
        setLayout(null);
        return;
      }
      const scale = Math.min(cw / nw, ch / nh);
      setLayout({
        scale,
        offsetX: (cw - nw * scale) / 2,
        offsetY: (ch - nh * scale) / 2,
      });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(imgEl);
    // Still watch the parent: when its size changes (orientation flip,
    // safe-area inset change after rotation, etc.) the img's percentage-
    // sized box also resizes, but the ResizeObserver on imgEl alone is
    // sometimes one frame late on Safari. Observing the parent too makes
    // recomputes prompt.
    const parent = imgEl.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, [imgEl]);

  // Also recompute once the image actually finishes loading (naturalWidth
  // arrives asynchronously for cached or just-decoded images). Bound to
  // imgEl identity so a fresh element triggers a fresh listener.
  useEffect(() => {
    if (!imgEl) return;
    if (imgEl.complete && imgEl.naturalWidth > 0) return;
    const onLoad = () => {
      const cw = imgEl.clientWidth;
      const ch = imgEl.clientHeight;
      const nw = imgEl.naturalWidth;
      const nh = imgEl.naturalHeight;
      if (!cw || !ch || !nw || !nh) return;
      const scale = Math.min(cw / nw, ch / nh);
      setLayout({
        scale,
        offsetX: (cw - nw * scale) / 2,
        offsetY: (ch - nh * scale) / 2,
      });
    };
    imgEl.addEventListener("load", onLoad);
    return () => imgEl.removeEventListener("load", onLoad);
  }, [imgEl]);

  if (!layout) return null;

  const delta = (((toKey - fromKey) % 12) + 12) % 12;
  const signedDelta = delta > 6 ? delta - 12 : delta;
  // Debug mode bypasses the early-out: even with no transposition we still
  // want to draw outlines around every detected chord so the user can verify
  // OCR coverage. Production mode preserves the original fast path.
  if (signedDelta === 0 && !debug) return null;

  const preferFlats = preferFlatsForKey(toKey);

  if (debug) {
    return (
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {result.chords.map((chord, i) => {
          const left = layout.offsetX + chord.bbox.x0 * layout.scale;
          const top = layout.offsetY + chord.bbox.y0 * layout.scale;
          const width = (chord.bbox.x1 - chord.bbox.x0) * layout.scale;
          const height = (chord.bbox.y1 - chord.bbox.y0) * layout.scale;
          const isSequence =
            !!chord.sequence && chord.sequence.length >= 2;
          const original = isSequence
            ? chord.sequence!.map((e) => e.pre + e.chord).join("")
            : chord.text;
          const newName =
            signedDelta !== 0
              ? isSequence
                ? chord
                    .sequence!.map(
                      (e) =>
                        e.pre + transposeChord(e.chord, signedDelta, preferFlats),
                    )
                    .join("")
                : transposeChord(chord.text, signedDelta, preferFlats)
              : original;
          const changed = newName !== original;
          // Cyan outline for "detected, name unchanged" (or no transpose
          // active); magenta for "detected and would be transposed".
          // Sequence tokens get an amber outline so they stand out from
          // single chords during debugging — they span a much wider bbox
          // and the user usually wants to verify the boundary. Both are
          // outline-only so the original printed text stays visible.
          const color = isSequence
            ? "#f59e0b"
            : changed
              ? "#ec4899"
              : "#06b6d4";
          const label = changed ? `${original}→${newName}` : original;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left,
                top,
                width,
                height,
                outline: `1.5px solid ${color}`,
                outlineOffset: 1,
                boxSizing: "border-box",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  top: -14,
                  background: color,
                  color: "#fff",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: 10,
                  fontWeight: 700,
                  lineHeight: "12px",
                  padding: "1px 3px",
                  borderRadius: 2,
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    );
  }
  // Background covers the original chord (white on a normal sheet, black
  // in invert mode); foreground is a vivid red instead of matching ink so
  // the user can tell at a glance which chord positions actually got
  // re-rendered. If any chord on the page stays the original colour, it
  // means OCR missed that bbox — that contrast is the whole point of
  // colouring the overlay differently from the source.
  const boxBg = invert ? "#000" : "#fff";
  const boxFg = invert ? "#fca5a5" : "#dc2626";

  // Page-wide UNIFORM font size for single-chord replacements. Tesseract
  // measures each glyph's bbox tightly, so the old per-chord sizing made
  // identically-printed chords come out at visibly different sizes. Drive a
  // single size off the MEDIAN detected glyph height so the overlay reads as
  // uniform as the print. (Sequence rows keep their own fit-to-width sizing —
  // one label spanning a whole section row genuinely needs to shrink.)
  //
  // 0.62 ≈ average monospace ch-width / em — used only by the sequence
  // width-fit below.
  const CHAR_W_RATIO = 0.62;
  const dispHeights = result.chords
    .map((c) => (c.bbox.y1 - c.bbox.y0) * layout.scale)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const medianH = dispHeights.length
    ? dispHeights[Math.floor(dispHeights.length / 2)]
    : 16;
  const uniformFont = Math.max(11, medianH * 1.05);
  const uniformPadX = Math.max(2, Math.round(medianH * 0.06));
  const uniformPadY = Math.max(3, Math.round(medianH * 0.22));
  const uniformBoxH = medianH + uniformPadY * 2;

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {result.chords.map((chord, i) => {
        // Sequence tokens (section header chord rows) carry an ordered array
        // of {chord, pre} entries with the original separators preserved
        // ("/" for measure boundaries, " " for adjacent chords sharing a
        // measure). Transpose each, rejoin with the SAME separators, and
        // render as ONE label. Single chords transpose directly.
        const isSequence = !!chord.sequence && chord.sequence.length >= 2;
        const newName = isSequence
          ? chord
              .sequence!.map(
                (e) =>
                  e.pre + transposeChord(e.chord, signedDelta, preferFlats),
              )
              .join("")
          : transposeChord(chord.text, signedDelta, preferFlats);
        const original = isSequence
          ? chord.sequence!.map((e) => e.pre + e.chord).join("")
          : chord.text;
        if (newName === original) return null; // nothing to change

        const glyphLeft = layout.offsetX + chord.bbox.x0 * layout.scale;
        const glyphTop = layout.offsetY + chord.bbox.y0 * layout.scale;
        const glyphW = (chord.bbox.x1 - chord.bbox.x0) * layout.scale;
        const glyphH = (chord.bbox.y1 - chord.bbox.y0) * layout.scale;

        // Resolve cover-box geometry + font size per kind. Tesseract's bboxes
        // hug the glyph tightly and clip accidentals/ascenders, so a little
        // padding keeps the original from peeking out around the replacement.
        let padX: number;
        let boxLeft: number;
        let boxTop: number;
        let boxMinW: number;
        let boxH: number;
        let fontSize: number;
        if (isSequence) {
          // Fit the whole "D / A / Bm / …" string inside the source bbox
          // width — a wide section row legitimately needs to shrink.
          padX = Math.max(2, Math.round(glyphH * 0.06));
          const padY = Math.max(3, Math.round(glyphH * 0.22));
          const widthBudget = (glyphW + padX * 2) * 1.2;
          const widthCap =
            widthBudget / Math.max(1, newName.length * CHAR_W_RATIO);
          fontSize = Math.max(10, Math.min(glyphH * 1.2, widthCap));
          boxLeft = glyphLeft - padX;
          boxTop = glyphTop - padY;
          boxMinW = glyphW + padX * 2;
          boxH = glyphH + padY * 2;
        } else {
          // Single chord: uniform size + box, centred on the original glyph's
          // vertical midline so differing bbox heights don't shift it. Width
          // overflow is allowed (nowrap) so a longer name ("C" → "F#") stays
          // readable; minWidth keeps the cover at least as wide as the glyph.
          padX = uniformPadX;
          fontSize = uniformFont;
          boxH = uniformBoxH;
          boxMinW = glyphW + uniformPadX * 2;
          boxLeft = glyphLeft - uniformPadX;
          boxTop = glyphTop + glyphH / 2 - uniformBoxH / 2;
        }

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: boxLeft,
              top: boxTop,
              minWidth: boxMinW,
              height: boxH,
              padding: `0 ${padX}px`,
              background: boxBg,
              color: boxFg,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontWeight: 700,
              fontSize,
              lineHeight: `${boxH}px`,
              whiteSpace: "nowrap",
              boxSizing: "border-box",
              display: "inline-block",
              textAlign: "left",
            }}
          >
            {newName}
          </div>
        );
      })}
    </div>
  );
}
