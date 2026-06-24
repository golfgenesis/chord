import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../store";
import { imageUrl } from "../lib/imageUrl";
import {
  ensureCached,
  getCachedImageBlobUrl,
  notifyCacheChanged,
} from "../lib/offlineDownload";
import { fetchChordText } from "../lib/chordText";
import { loadLocal, saveLocal } from "../lib/persist";
import { useWakeLock } from "../hooks/useWakeLock";
import { ChordSheet } from "./ChordSheet";
import { NextSongDrawer } from "./NextSongDrawer";
import type { Song } from "../types";
import { parseChordpro } from "../lib/chordpro";
import { detectKey } from "../lib/keyDetect";
import { preferFlatsForKey, relativeMajorTonic } from "../lib/musicTheory";

// Auto-fill the source key from chord detection only when the detected chords
// fit a diatonic scale well enough to trust. A fully diatonic chart scores
// 0.9–1.0; below 0.5 the detection is probably noise and we leave it at C.
const AUTO_DETECT_CONFIDENCE_MIN = 0.5;

// Per-song transpose preferences live as a single localStorage map keyed by
// songId, so opening a song restores the (from, to) the user last set for it.
type TransposeMap = Record<string, { from: number; to: number }>;

const TRANSPOSE_KEY = "transpose";
function loadTransposeMap(): TransposeMap {
  return loadLocal<TransposeMap>(TRANSPOSE_KEY, {});
}
function saveTransposeMap(map: TransposeMap) {
  saveLocal(TRANSPOSE_KEY, map);
}

// Per-song fetch state for the ChordPro markdown (fetched from R2, SW-cached).
// "loading" until the fetch resolves; "ready" with text → render the sheet;
// "missing" (404 / offline+uncached) → fall back to the WebP image.
type TextFetch = {
  id: number;
  status: "loading" | "ready" | "missing";
  text: string | null;
};

export function Fullscreen() {
  const song = useApp((s) => s.viewing);
  const close = useApp((s) => s.close);
  const open = useApp((s) => s.open);
  const invertImages = useApp((s) => s.invertImages);
  const toggleInvertImages = useApp((s) => s.toggleInvertImages);

  // Bumped by "ลองอีกครั้ง" + on regaining network: re-fetches the text AND
  // re-races the image cache.
  const [retryToken, setRetryToken] = useState(0);

  // ── ChordPro text: primary view ────────────────────────────────────────
  // Fetched per song from R2 (the service worker serves it instantly when
  // cached, even offline — see src/sw.ts + src/lib/chordText.ts).
  const [textFetch, setTextFetch] = useState<TextFetch | null>(null);
  const current = song && textFetch && textFetch.id === song.id ? textFetch : null;
  // No entry for the current song yet → still loading (avoids a synchronous
  // setState in the fetch effect; mirrors the derived-loaded pattern below).
  const textStatus: TextFetch["status"] = current?.status ?? "loading";
  const sheetText = current?.status === "ready" ? current.text : null;

  useEffect(() => {
    if (!song) return;
    let cancelled = false;
    const id = song.id;
    const ctrl = new AbortController();
    const snap = song;
    fetchChordText(snap, ctrl.signal).then((text) => {
      if (cancelled) return;
      setTextFetch({ id, status: text ? "ready" : "missing", text });
    });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [song?.id, song, retryToken]);

  const parsedSheet = useMemo(
    () => (sheetText ? parseChordpro(sheetText) : null),
    [sheetText],
  );
  const textMode = textStatus === "ready" && parsedSheet != null;
  const imageFallback = textStatus === "missing" || (textStatus === "ready" && parsedSheet == null);

  const textDetectedKey = useMemo(
    () => (parsedSheet ? detectKey(parsedSheet.chords) : null),
    [parsedSheet],
  );
  // Source key: the {key:} directive wins, else chord detection above the
  // confidence floor, else C. Deterministic from the sheet, so re-deriving on
  // every open is stable — no caching effect needed.
  const textDefaultKey = useMemo(() => {
    if (!parsedSheet) return 0;
    if (parsedSheet.sourceKey != null) return parsedSheet.sourceKey;
    if (textDetectedKey && textDetectedKey.confidence >= AUTO_DETECT_CONFIDENCE_MIN)
      return relativeMajorTonic(textDetectedKey.tonic, textDetectedKey.mode);
    return 0;
  }, [parsedSheet, textDetectedKey]);

  // ── Image fallback state ───────────────────────────────────────────────
  // `loadedId` tracks which song's image finished; derived `imgLoaded` resets
  // automatically when song.id changes. errorId/online drive the error card.
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const imgLoaded = song != null && loadedId === song.id;
  const [errorId, setErrorId] = useState<number | null>(null);
  const errored = song != null && errorId === song.id;
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Scrollable sheet container — jump back to top on song change.
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // --- "Next song" queue --------------------------------------------------
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [nextSong, setNextSong] = useState<Song | null>(null);
  const edgeSwipeRef = useRef<{ x: number; y: number; edge: boolean } | null>(null);

  const goToNext = useCallback(() => {
    if (!nextSong) return;
    open(nextSong);
    setNextSong(null);
  }, [nextSong, open]);

  // Transposition state (localStorage, per song). Text mode KNOWS its source
  // key (declared in / detected from the sheet), so `from` is authoritative
  // and the user only picks a target.
  const [transposeMap, setTransposeMap] = useState<TransposeMap>(() => loadTransposeMap());
  const currentEntry = song ? transposeMap[String(song.id)] : undefined;
  const fromKey = textDefaultKey;
  const toKey = currentEntry?.to ?? textDefaultKey;
  const signedDelta = useMemo(() => {
    const d = ((toKey - fromKey) % 12 + 12) % 12;
    return d > 6 ? d - 12 : d;
  }, [fromKey, toKey]);
  const transposeActive = signedDelta !== 0;

  const updateTranspose = useCallback(
    (next: { from: number; to: number }) => {
      if (!song) return;
      const id = String(song.id);
      setTransposeMap((prev) => {
        const updated: TransposeMap = { ...prev, [id]: next };
        saveTransposeMap(updated);
        return updated;
      });
    },
    [song],
  );
  const setTo = useCallback(
    (k: number) => updateTranspose({ from: fromKey, to: k }),
    [fromKey, updateTranspose],
  );
  const resetTranspose = useCallback(() => {
    if (!song) return;
    const id = String(song.id);
    setTransposeMap((prev) => {
      const next: TransposeMap = { ...prev, [id]: { from: textDefaultKey, to: textDefaultKey } };
      saveTransposeMap(next);
      return next;
    });
  }, [song, textDefaultKey]);

  // ── Image blob fast-path (only used for the image fallback) ─────────────
  // Read the cached image directly out of Cache Storage as a blob URL,
  // bypassing the SW's slow cold lookup on idle iPad PWAs.
  const [blob, setBlob] = useState<{ songId: number; url: string } | null>(null);
  const src = song
    ? blob && blob.songId === song.id
      ? blob.url
      : imageUrl(song)
    : "";

  useEffect(() => {
    if (!song || !imageFallback) return;
    let cancelled = false;
    const songId = song.id;
    getCachedImageBlobUrl(song).then((blobUrl) => {
      if (cancelled || !blobUrl) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        return;
      }
      const liveImg = imgRef.current;
      if (liveImg && liveImg.complete && liveImg.naturalWidth > 0) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      setBlob((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { songId, url: blobUrl };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [song?.id, song, imageFallback, retryToken]);

  // Watch network: swap the error-card copy and auto-retry when signal returns.
  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      if (errored) {
        setErrorId(null);
        setRetryToken((t) => t + 1);
      }
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [errored]);

  const retry = useCallback(() => {
    setErrorId(null);
    setRetryToken((t) => t + 1);
  }, []);

  // Revoke the active blob URL on unmount (tracked via ref for the latest URL).
  const blobRef = useRef(blob);
  useEffect(() => {
    blobRef.current = blob;
  }, [blob]);
  useEffect(() => {
    return () => {
      if (blobRef.current) URL.revokeObjectURL(blobRef.current.url);
    };
  }, []);

  // The "image done" path — called from <img onLoad> AND the ref callback (for
  // cache-instant hits where `complete` is already true on attach).
  const markLoaded = useCallback(
    (id: number) => {
      setLoadedId(id);
      if (song?.id === id) {
        ensureCached(song).then((ok) => {
          if (ok) notifyCacheChanged();
        });
      }
    },
    [song],
  );
  const handleImgRef = useCallback(
    (el: HTMLImageElement | null) => {
      imgRef.current = el;
      if (el && song && el.complete && el.naturalWidth > 0 && loadedId !== song.id) {
        markLoaded(song.id);
      }
    },
    [song, loadedId, markLoaded],
  );

  useEffect(() => {
    if (!song) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [song, close]);

  // New song → jump back to the top.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [song?.id]);

  // Hold a screen wake lock while a chord sheet is open.
  useWakeLock(song != null);

  if (!song) return null;

  const hasNext = nextSong != null && nextSong.id !== song.id;
  const paper = textMode || imgLoaded; // show the white/black "paper" backdrop
  const showSpinner =
    textStatus === "loading" || (imageFallback && !imgLoaded && !errored);

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in flex-col bg-bg bg-page-grad"
      onTouchStart={(e) => {
        const t = e.touches[0];
        edgeSwipeRef.current = {
          x: t.clientX,
          y: t.clientY,
          edge: t.clientX > window.innerWidth - 30,
        };
      }}
      onTouchMove={(e) => {
        const s = edgeSwipeRef.current;
        if (!s || !s.edge) return;
        const t = e.touches[0];
        const dx = t.clientX - s.x;
        const dy = t.clientY - s.y;
        if (dx < -50 && Math.abs(dx) > Math.abs(dy)) {
          setDrawerOpen(true);
          edgeSwipeRef.current = null;
        }
      }}
    >
      <header
        className="relative z-10 flex shrink-0 items-center gap-2 border-b border-white/[0.08] glass-strong px-3.5 py-2.5 text-white sm:gap-3 sm:px-5 sm:py-3"
        style={{ paddingTop: "calc(0.625rem + var(--safe-top))" }}
      >
        <div className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-brand-grad shadow-glow-sm ring-1 ring-white/10">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-b from-white/25 to-transparent"
          />
          <svg viewBox="0 0 24 24" fill="currentColor" className="relative size-[18px]">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
        <h2 className="min-w-0 flex-1 truncate font-display text-[17px] font-semibold leading-[1.4] tracking-tight sm:text-[20px] sm:leading-[1.4]">
          {song.name}
        </h2>
        <div className="flex shrink-0 items-center gap-1.5 sm:contents">
          {/* Transpose chip — only in text mode (you can't move chords on a
              bitmap image without OCR, which we no longer do). */}
          {textMode && (
            <DetectionChip
              fromKey={fromKey}
              toKey={toKey}
              detectedConfidence={textDetectedKey?.confidence ?? null}
              chordCount={parsedSheet!.chords.length}
              transposeActive={transposeActive}
              onChangeTo={setTo}
              onReset={resetTranspose}
            />
          )}
          <button
            onClick={toggleInvertImages}
            className={`grid size-9 shrink-0 place-items-center rounded-xl border shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] transition active:scale-95 ${
              invertImages
                ? "border-brand/40 bg-brand-soft text-brand hover:bg-brand/20"
                : "border-white/[0.12] bg-white/[0.06] text-white/80 hover:border-white/20 hover:bg-white/[0.12]"
            }`}
            aria-label={invertImages ? "ปิด invert (โหมดสว่าง)" : "เปิด invert (โหมดมืด)"}
            title={invertImages ? "กำลังใช้โหมดมืด — แตะเพื่อกลับเป็นกระดาษขาว" : "กำลังใช้โหมดสว่าง — แตะเพื่อเปลี่ยนเป็นโหมดมืด"}
          >
            <ContrastIcon />
          </button>
          <button
            onClick={close}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.12] bg-white/[0.06] text-[14px] font-semibold tracking-[-0.005em] text-white/80 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] transition hover:border-white/20 hover:bg-white/[0.12] hover:text-white active:scale-95 sm:w-auto sm:gap-2 sm:px-3.5 sm:py-2 sm:text-white"
            aria-label="Close"
          >
            <CloseIcon className="sm:hidden" />
            <span className="hidden sm:inline">ย้อนกลับ</span>
            <span className="hidden text-white/40 sm:inline">ESC</span>
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className={`relative min-h-0 flex-1 ${
          textMode ? "overflow-y-auto overflow-x-hidden" : "overflow-hidden"
        } ${paper ? (invertImages ? "bg-black" : "bg-white") : "bg-transparent"}`}
        style={{ paddingBottom: "var(--safe-bottom)" }}
        // Tap-to-close only in image mode; in text mode a stray tap while
        // reading should never kick you out (exit via the header X).
        onClick={() => {
          if (!textMode) close();
        }}
      >
        {showSpinner && (
          // Delayed via the `.spinner-delayed` CSS keyframe — cache hits reach
          // their loaded state before the 150 ms delay elapses, so it never
          // paints for instant loads.
          <div className="spinner-delayed pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 px-6">
            <div className="relative">
              <div
                aria-hidden
                className="absolute inset-0 -m-6 rounded-full bg-brand-grad opacity-30 blur-3xl"
              />
              <div className="relative grid size-16 place-items-center rounded-2xl bg-brand-grad shadow-glow ring-1 ring-white/10 animate-pulse-glow">
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-b from-white/25 to-transparent"
                />
                <svg viewBox="0 0 24 24" fill="currentColor" className="relative size-7 text-white" aria-hidden="true">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <p className="font-display text-[14px] font-semibold tracking-[-0.005em] text-ink">
                กำลังเปิดเพลง
              </p>
              <p className="max-w-[280px] truncate text-[12px] text-ink-mute">{song.name}</p>
            </div>
          </div>
        )}
        {imageFallback && errored && (
          <ErrorOverlay online={online} onRetry={retry} onClose={close} />
        )}

        <div className={`relative w-full ${textMode ? "flex min-h-full flex-col" : "h-full"}`}>
          {textMode ? (
            <ChordSheet sheet={parsedSheet!} fromKey={fromKey} toKey={toKey} invert={invertImages} />
          ) : imageFallback ? (
            <img
              key={`${song.id}-${retryToken}`}
              ref={handleImgRef}
              src={src}
              alt=""
              crossOrigin="anonymous"
              onLoad={() => {
                setLoadedId(song.id);
                ensureCached(song).then((ok) => {
                  if (ok) notifyCacheChanged();
                });
              }}
              onError={() => setErrorId(song.id)}
              onClick={(e) => e.stopPropagation()}
              draggable={false}
              decoding="async"
              className="block h-full w-full select-none object-contain"
              style={{
                filter: invertImages ? "invert(1)" : undefined,
                imageRendering: "auto",
                display: errored ? "none" : undefined,
              }}
            />
          ) : null}
        </div>
      </div>

      {hasNext && (
        <button
          onClick={goToNext}
          className="absolute left-1/2 z-20 flex max-w-[80%] -translate-x-1/2 items-center gap-2.5 rounded-full border border-white/10 bg-bg-soft/90 py-2 pl-4 pr-2 text-white shadow-2xl backdrop-blur-xl transition active:scale-95"
          style={{ bottom: "calc(var(--safe-bottom) + 1rem)" }}
          aria-label={`ไปเพลงถัดไป: ${nextSong!.name}`}
        >
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-ink-mute">ถัดไป</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{nextSong!.name}</span>
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-grad shadow-glow-sm ring-1 ring-white/10">
            <SkipNextIcon />
          </span>
        </button>
      )}

      <button
        onClick={() => setDrawerOpen(true)}
        className="absolute right-0 top-1/2 z-20 grid h-16 w-6 -translate-y-1/2 place-items-center rounded-l-xl border-y border-l border-white/10 bg-bg-soft/70 text-white/70 backdrop-blur-xl transition hover:bg-bg-soft/90 hover:text-white active:scale-95"
        aria-label="เลือกเพลงถัดไป"
        title="เลือกเพลงถัดไป (ลากจากขอบขวา)"
      >
        <ChevronLeftIcon />
      </button>

      <NextSongDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        currentId={song.id}
        nextId={nextSong?.id ?? null}
        onPick={(s) => {
          setNextSong(s);
          setDrawerOpen(false);
        }}
      />
    </div>
  );
}

function SkipNextIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="size-[18px]" aria-hidden="true">
      <path d="M6 5v14l9-7z" />
      <rect x="16" y="5" width="2.5" height="14" rx="1" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="size-[18px]" aria-hidden="true">
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

const KEY_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
const NOTE_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const NOTE_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;
function keyDisplay(k: number): string {
  return preferFlatsForKey(k) ? NOTE_FLAT[k] : NOTE_SHARP[k];
}
const POPOVER_WIDTH = 296;

function confidenceTier(conf: number): "high" | "mid" | "low" {
  if (conf >= 0.85) return "high";
  if (conf >= 0.65) return "mid";
  return "low";
}

/**
 * Header-mounted transpose chip + popover. Shows the source key (and target,
 * when transposed). The source key is authoritative — it's declared in / read
 * off the sheet — so only the target is editable. Tapping opens a 12-key grid.
 *
 * Portaled to document.body so the header's `backdrop-filter: blur` doesn't
 * clip the `position: fixed` popover on iOS Safari.
 */
function DetectionChip({
  fromKey,
  toKey,
  detectedConfidence,
  chordCount,
  transposeActive,
  onChangeTo,
  onReset,
}: {
  fromKey: number;
  toKey: number;
  detectedConfidence: number | null;
  chordCount: number;
  transposeActive: boolean;
  onChangeTo: (v: number) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = chipRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const leftAlignedToRight = r.right - POPOVER_WIDTH;
      const clampedLeft = Math.max(12, Math.min(vw - POPOVER_WIDTH - 12, leftAlignedToRight));
      setPos({ top: r.bottom + 8, left: clampedLeft });
    };
    update();
    const ro = new ResizeObserver(update);
    if (chipRef.current) ro.observe(chipRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  const conf = detectedConfidence ?? 0;
  const tier = confidenceTier(conf);
  const dotClass =
    tier === "high"
      ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]"
      : tier === "mid"
      ? "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]"
      : "bg-rose-400 shadow-[0_0_6px_rgba(251,113,133,0.5)]";

  const closePopover = () => setOpen(false);
  const pickTo = (k: number) => {
    onChangeTo(k);
    closePopover();
  };
  const handleReset = () => {
    onReset();
    closePopover();
  };

  return (
    <>
      <button
        ref={chipRef}
        onClick={() => setOpen((v) => !v)}
        aria-label="เลือกคีย์"
        className={`relative flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-[12.5px] font-semibold tracking-tight shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] transition active:scale-95 ${
          transposeActive
            ? "border-brand/45 bg-brand-soft text-brand hover:bg-brand/20"
            : "border-white/[0.12] bg-white/[0.06] text-white/90 hover:border-white/20 hover:bg-white/[0.12]"
        }`}
      >
        <span className={`inline-block size-2 rounded-full ${dotClass}`} aria-hidden="true" />
        <span className="tabular-nums">{keyDisplay(fromKey)}</span>
        {transposeActive && (
          <>
            <span className="opacity-50">→</span>
            <span className="tabular-nums">{keyDisplay(toKey)}</span>
          </>
        )}
        <ChevronDownIcon flip={open} />
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[60]" onClick={closePopover} />
            <div
              role="dialog"
              aria-label="เลือกคีย์"
              onClick={(e) => e.stopPropagation()}
              className="fixed z-[61] flex flex-col gap-2.5 rounded-2xl border border-white/10 bg-bg-soft/95 p-3 shadow-2xl backdrop-blur-xl animate-slide-up"
              style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
            >
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="text-ink-dim">
                  เปลี่ยนคีย์ตามทฤษฎีดนตรี ·{" "}
                  <span className="font-semibold text-ink">{chordCount}</span> คอร์ด
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
                  คีย์ต้นฉบับ
                </span>
                <span className="text-[13px] font-bold tabular-nums text-ink">
                  {keyDisplay(fromKey)}
                  <span className="ml-1.5 text-[10.5px] font-medium text-ink-dim/70">จากแผ่นโน้ต</span>
                </span>
              </div>

              <KeyGrid heading="เปลี่ยนเป็น" hint="แตะคีย์ที่ต้องการ" value={toKey} onPick={pickTo} accent="brand" />

              {transposeActive && (
                <div className="-mb-0.5 border-t border-white/[0.06] pt-2.5">
                  <button
                    onClick={handleReset}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-white/[0.12] bg-white/[0.06] py-2 text-[12px] font-semibold text-white/85 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] transition hover:border-white/20 hover:bg-white/[0.12] hover:text-white active:scale-[0.98]"
                  >
                    <RetryIcon />
                    คืนคีย์เดิม ({keyDisplay(fromKey)})
                  </button>
                </div>
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

function KeyGrid({
  heading,
  hint,
  value,
  onPick,
  accent,
}: {
  heading: string;
  hint?: string;
  value: number;
  onPick: (k: number) => void;
  accent: "brand" | "muted";
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">{heading}</span>
        {hint && <span className="text-[10.5px] text-ink-dim/70">{hint}</span>}
      </div>
      <div className="grid grid-cols-6 gap-1">
        {KEY_VALUES.map((k) => {
          const active = k === value;
          const activeClass =
            accent === "brand"
              ? "bg-brand-grad text-white shadow-glow-sm ring-1 ring-white/15"
              : "border border-brand/50 bg-brand-soft text-brand";
          return (
            <button
              key={k}
              onClick={() => onPick(k)}
              title={NOTE_FLAT[k] !== NOTE_SHARP[k] ? `${NOTE_SHARP[k]} / ${NOTE_FLAT[k]}` : NOTE_SHARP[k]}
              className={`flex h-9 items-center justify-center rounded-lg text-[13px] font-bold tabular-nums transition active:scale-95 ${
                active ? activeClass : "bg-white/[0.06] text-white/85 hover:bg-white/[0.12]"
              }`}
            >
              {keyDisplay(k)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChevronDownIcon({ flip }: { flip?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-3 opacity-70 transition-transform ${flip ? "rotate-180" : ""}`} aria-hidden="true">
      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Shown in place of a broken image when the chord sheet fails to load AND there
 * is no text — usually offline + neither text nor image cached yet.
 */
function ErrorOverlay({
  online,
  onRetry,
  onClose,
}: {
  online: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center px-6 text-center animate-fade-in" onClick={(e) => e.stopPropagation()}>
      <div className="relative mb-6">
        <div aria-hidden className="absolute inset-0 -m-5 rounded-full bg-brand-grad opacity-25 blur-2xl" />
        <div className="relative grid size-20 place-items-center rounded-[26px] bg-brand-grad-soft ring-1 ring-brand/30 shadow-glow-sm">
          {online ? <CloudWarnIcon /> : <CloudOffIcon />}
        </div>
      </div>
      <h3 className="font-display text-[20px] font-semibold tracking-[-0.015em] text-ink sm:text-[22px]">
        {online ? "โหลดเพลงไม่สำเร็จ" : "อยู่ในโหมดออฟไลน์"}
      </h3>
      <p className="mt-2 max-w-xs text-[13.5px] leading-relaxed text-ink-dim sm:text-[14px]">
        {online ? "อาจเป็นสัญญาณห่วยชั่วคราว — ลองอีกครั้งดูนะ" : "เพลงนี้ยังไม่ถูกบันทึกลงเครื่อง เลยเปิดดูตอนนี้ไม่ได้"}
      </p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="rounded-2xl border border-line/60 bg-bg-soft/80 px-5 py-3 text-[14px] font-semibold text-ink-dim shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition hover:bg-bg-hover hover:text-ink active:scale-[0.98]"
        >
          ย้อนกลับ
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          className="flex items-center gap-2 rounded-2xl bg-brand-grad px-5 py-3 text-[14px] font-semibold text-white shadow-glow-sm ring-1 ring-white/10 transition hover:brightness-110 active:scale-[0.98]"
        >
          <RetryIcon />
          ลองอีกครั้ง
        </button>
      </div>
    </div>
  );
}

function CloudOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="size-9 text-brand" aria-hidden="true">
      <path d="m2 2 20 20" />
      <path d="M5.78 5.78A4 4 0 0 0 4 9a4 4 0 0 0 4 4h8" />
      <path d="M10.6 5.08A6 6 0 0 1 17 8a4 4 0 0 1 3 7" />
    </svg>
  );
}

function CloudWarnIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="size-9 text-brand" aria-hidden="true">
      <path d="M17.5 19a4.5 4.5 0 1 0-4.42-5.36A6 6 0 1 0 7 19h10.5Z" />
      <path d="M12 9v3" />
      <circle cx="12" cy="15" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-[16px]" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`size-[18px] ${className ?? ""}`} aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function ContrastIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path d="M 12 3 A 9 9 0 0 0 12 21 Z" fill="currentColor" />
    </svg>
  );
}
