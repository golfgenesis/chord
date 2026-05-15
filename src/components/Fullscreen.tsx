import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../store";
import { imageUrl } from "../lib/imageUrl";
import {
  ensureCached,
  getCachedImageBlobUrl,
  notifyCacheChanged,
} from "../lib/offlineDownload";
import { loadLocal, saveLocal } from "../lib/persist";
import { ChordOverlay } from "./ChordOverlay";
import { runChordOCR, type OCRResult } from "../lib/chordOCR";
import { detectKey, type KeyEstimate } from "../lib/keyDetect";
import { preferFlatsForKey, relativeMajorTonic } from "../lib/musicTheory";

// Auto-fill the From key from OCR's key detection only when at least half
// the detected chords fit the chosen diatonic scale. With the chord-line
// gating in [chordOCR.ts](../lib/chordOCR.ts), a fully diatonic chart hits
// 0.9–1.0; songs that borrow a chord or two come in at 0.7–0.85; anything
// below 0.5 means the detected list is probably garbage and we shouldn't
// pretend we know the key.
const AUTO_DETECT_CONFIDENCE_MIN = 0.5;

// Per-song transpose preferences live as a single localStorage map keyed by
// songId, so opening a song restores the (from, to) the user last set for it.
// Identity entries (from === to) aren't stored — wiping back to the default
// removes the song's key from the map.
type TransposeMap = Record<string, { from: number; to: number }>;

const TRANSPOSE_KEY = "transpose";
function loadTransposeMap(): TransposeMap {
  return loadLocal<TransposeMap>(TRANSPOSE_KEY, {});
}
function saveTransposeMap(map: TransposeMap) {
  saveLocal(TRANSPOSE_KEY, map);
}

// OCR debug-overlay toggle. Persisted globally (not per-song) because it's
// a developer/diagnostic flag, not a per-song preference.
const OCR_DEBUG_KEY = "ocr-debug";

export function Fullscreen() {
  const song = useApp((s) => s.viewing);
  const close = useApp((s) => s.close);
  const invertImages = useApp((s) => s.invertImages);
  const toggleInvertImages = useApp((s) => s.toggleInvertImages);
  // Track which song id has finished loading. `loaded` is derived, so it
  // automatically resets to false when `song.id` changes — no effect needed.
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const loaded = song != null && loadedId === song.id;
  // Same shape for the error path. `<img onError>` sets errorId; the
  // derived `errored` flips back to false automatically the moment the
  // user switches songs (because errorId !== new song.id).
  const [errorId, setErrorId] = useState<number | null>(null);
  const errored = song != null && errorId === song.id;
  // Bumped by the "ลองอีกครั้ง" button. Doubles as an <img> key so React
  // remounts the element — that's what forces the browser to actually
  // re-fetch (a same-src reassignment serves the failed entry from the
  // image memory cache and onError fires again instantly).
  const [retryToken, setRetryToken] = useState(0);
  // navigator.onLine drives the copy on the error card — "ออฟไลน์" vs
  // "โหลดไม่สำเร็จ". Auto-retry on regaining network so the user doesn't
  // have to tap the button if they were just walking out of a dead spot.
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const imgRef = useRef<HTMLImageElement | null>(null);
  // State copy of the <img> element. We need it as state (not just a ref)
  // so ChordOverlay re-renders when the element mounts — refs don't trigger
  // re-renders on assignment. handleImgRef below keeps both in sync.
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);

  // Custom pinch-zoom transform applied to a wrapper around <img> +
  // ChordOverlay. The viewport-meta `user-scalable=yes` hack works in
  // mobile Safari browser, but iPad Safari PWAs (launched from the home
  // screen, display: standalone) lock the viewport at scale=1 and ignore
  // mid-page meta updates — so the only way to give those users zoom is
  // to do it ourselves via CSS transform. `animate` is set only for
  // double-tap snaps; live pinch / pan keeps transition off for instant
  // tracking. The ref is the source of truth for handlers (they need the
  // latest values mid-gesture); state drives rendering. `setZoom` writes
  // both atomically so they never disagree.
  type ZoomState = {
    scale: number;
    tx: number;
    ty: number;
    animate: boolean;
  };
  const ZOOM_IDENTITY: ZoomState = { scale: 1, tx: 0, ty: 0, animate: false };
  const [zoom, setZoomState] = useState<ZoomState>(ZOOM_IDENTITY);
  const zoomRef = useRef<ZoomState>(ZOOM_IDENTITY);
  const setZoom = useCallback((next: ZoomState) => {
    zoomRef.current = next;
    setZoomState(next);
  }, []);
  const zoomWrapRef = useRef<HTMLDivElement | null>(null);
  // Keep zoomRef in sync with rendered state. Touch handlers below read
  // from the ref to avoid stale-closure issues; this effect makes sure
  // out-of-band state changes (like the song-switch reset) propagate to
  // the ref on commit.
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  // Reset the custom zoom whenever the user switches songs. Done during
  // render via the "reset state when a prop changes" pattern (React docs)
  // rather than an effect, so the new <img> never gets a frame of the
  // previous song's zoom applied to it. The ref-sync effect below will
  // catch zoomRef up to the reset value on the next commit.
  const [zoomSongId, setZoomSongId] = useState<number | null>(song?.id ?? null);
  if ((song?.id ?? null) !== zoomSongId) {
    setZoomSongId(song?.id ?? null);
    setZoomState(ZOOM_IDENTITY);
  }

  // OCR state for the song currently being viewed. Derived: a stored
  // ocrState with a non-matching songId behaves as "not run yet". Switching
  // songs naturally invalidates without an effect-driven reset.
  const [ocrState, setOcrState] = useState<{
    songId: number;
    result: OCRResult;
    detectedKey: KeyEstimate | null;
  } | null>(null);
  const [ocrError, setOcrError] = useState<{ songId: number } | null>(null);
  const currentOcr =
    ocrState && song && ocrState.songId === song.id ? ocrState : null;
  const currentOcrError =
    ocrError && song && ocrError.songId === song.id ? ocrError : null;

  // OCR debug overlay — when on, ChordOverlay outlines every detected chord
  // (with its OCR'd text) instead of just rendering transposed replacements.
  // Persisted to localStorage so the developer can leave it on across reloads.
  const [ocrDebug, setOcrDebug] = useState<boolean>(() =>
    loadLocal<boolean>(OCR_DEBUG_KEY, false),
  );
  const toggleOcrDebug = useCallback(() => {
    setOcrDebug((v) => {
      const next = !v;
      saveLocal(OCR_DEBUG_KEY, next);
      return next;
    });
  }, []);

  // Transposition state. `map` lives in localStorage and survives reloads;
  // `fromKey` / `toKey` are the current song's entry resolved from it. The
  // map's structure (one entry per touched song) keeps the storage small —
  // most users only transpose a handful of songs.
  const [transposeMap, setTransposeMap] = useState<TransposeMap>(() => loadTransposeMap());
  const currentEntry = song ? transposeMap[String(song.id)] : undefined;
  const fromKey = currentEntry?.from ?? 0;
  const toKey = currentEntry?.to ?? 0;
  const signedDelta = useMemo(() => {
    const d = ((toKey - fromKey) % 12 + 12) % 12;
    return d > 6 ? d - 12 : d;
  }, [fromKey, toKey]);
  const transposeActive = signedDelta !== 0;

  // Persist any non-default transpose selection — including identity
  // (from === to), so an auto-detected key sticks even before the user
  // picks a target. `resetTranspose` is the only path that deletes the
  // entry, so the storage map stays bounded to songs the user has
  // actually engaged with.
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

  const setFrom = useCallback(
    (k: number) => updateTranspose({ from: k, to: toKey }),
    [toKey, updateTranspose],
  );
  const setTo = useCallback(
    (k: number) => updateTranspose({ from: fromKey, to: k }),
    [fromKey, updateTranspose],
  );
  // "Cancel transpose" — snap BOTH from and to back to the auto-detected
  // source key (so the chip keeps showing the same key the user trusted
  // for the detection) with delta = 0. Falling back to a hard delete
  // would reset the chip to C, which feels broken when the page clearly
  // shows the song is in a different key.
  const resetTranspose = useCallback(() => {
    if (!song) return;
    const id = String(song.id);
    const detected = currentOcr?.detectedKey;
    setTransposeMap((prev) => {
      let next: TransposeMap;
      if (detected && detected.confidence >= AUTO_DETECT_CONFIDENCE_MIN) {
        const defaultTonic = relativeMajorTonic(detected.tonic, detected.mode);
        next = {
          ...prev,
          [id]: { from: defaultTonic, to: defaultTonic },
        };
      } else if (id in prev) {
        next = { ...prev };
        delete next[id];
      } else {
        return prev;
      }
      saveTransposeMap(next);
      return next;
    });
  }, [song, currentOcr]);

  // Kick off OCR lazily when the panel is open and we have a loaded image.
  // The result is cached in IndexedDB by chordOCR.ts, so subsequent visits
  // to the same song skip the work. We set state only inside the async
  // .then callback (mirroring the blob-cache effect above) to stay clear
  // of the react-hooks/set-state-in-effect rule.
  useEffect(() => {
    if (!song || !imgEl || !loaded) return;
    if (currentOcr) return; // already done for this song
    if (currentOcrError) return; // failed for this song; don't retry on every render
    let cancelled = false;
    const songSnap = song;
    runChordOCR(songSnap.id, imgEl)
      .then((result) => {
        if (cancelled) return;
        // Flatten sequence tokens (section header chord rows where one
        // OCR'd word holds multiple chord names) so each individual chord
        // contributes to key detection. Single tokens pass through as-is.
        const flat: string[] = [];
        for (const c of result.chords) {
          if (c.sequence && c.sequence.length > 0) {
            for (const e of c.sequence) flat.push(e.chord);
          } else flat.push(c.text);
        }
        const detectedKey = detectKey(flat);
        setOcrState({ songId: songSnap.id, result, detectedKey });
        // Auto-fill the From key from the detection, but ONLY if the user
        // hasn't already chosen one for this song. We never overwrite a
        // manual pick — the user is always right.
        if (detectedKey && detectedKey.confidence >= AUTO_DETECT_CONFIDENCE_MIN) {
          setTransposeMap((prev) => {
            if (prev[String(songSnap.id)]) return prev;
            const defaultTonic = relativeMajorTonic(
              detectedKey.tonic,
              detectedKey.mode,
            );
            const updated: TransposeMap = {
              ...prev,
              [String(songSnap.id)]: {
                from: defaultTonic,
                to: defaultTonic,
              },
            };
            saveTransposeMap(updated);
            return updated;
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("OCR failed:", err);
        setOcrError({ songId: songSnap.id });
      });
    return () => {
      cancelled = true;
    };
  }, [song, imgEl, loaded, currentOcr, currentOcrError]);
  // Loading spinner is delayed by the `.spinner-delayed` keyframe in
  // [src/index.css](../index.css) (150 ms hold, then opacity → 1). Cache
  // hits unmount the spinner before its keyframe fires, so no spinner
  // paints for cached loads. No JS state / effect needed.

  // Blob: URL of the cached image, scoped to a specific song id. State,
  // not ref — React must re-render with the swapped src. Derived src
  // below picks blob when songId matches; otherwise falls back to the
  // network URL. This shape lets the effect set state ONLY inside an
  // async callback (eslint react-hooks/set-state-in-effect) — there is
  // no synchronous setSrc in the effect body.
  //
  // Why blob-direct: the SW's CacheFirst lookup costs 200–2000 ms when
  // the SW has been idle on iPad PWAs (cold SQLite cache + SW wake-up).
  // `cache.match` from the page bypasses that — same Cache Storage, no
  // SW round-trip — so cached images appear in ~20 ms instead of 2 s.
  const [blob, setBlob] = useState<{ songId: number; url: string } | null>(
    null,
  );
  const src = song
    ? blob && blob.songId === song.id
      ? blob.url
      : imageUrl(song)
    : "";

  // Race the cache for every song change. If the SW already finished
  // when the blob arrives, we DON'T downgrade — swapping src on a
  // loaded <img> would trigger a useless redecode flash. `retryToken`
  // is in the deps so "ลองอีกครั้ง" also re-races the cache (a song that
  // was just prefetched in the background might be available now even
  // if the initial network attempt failed).
  useEffect(() => {
    if (!song) return;
    let cancelled = false;
    const songId = song.id;
    getCachedImageBlobUrl(song).then((blobUrl) => {
      if (cancelled || !blobUrl) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        return;
      }
      const liveImg = imgRef.current;
      if (liveImg && liveImg.complete && liveImg.naturalWidth > 0) {
        // SW beat us — keep the already-painted bitmap.
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
  }, [song?.id, song, retryToken]);

  // Watch network status so the error card can swap copy between
  // "offline" and "load failed", and auto-retry when the user walks
  // back into signal. We only trigger the auto-retry when an error is
  // currently showing — otherwise a regular online/offline flap would
  // pointlessly nudge a healthy load.
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

  // Revoke the currently-active blob URL on unmount.
  // Tracking via ref so the cleanup sees the latest URL, not whatever was
  // captured when this effect first ran.
  const blobRef = useRef(blob);
  useEffect(() => {
    blobRef.current = blob;
  }, [blob]);
  useEffect(() => {
    return () => {
      if (blobRef.current) URL.revokeObjectURL(blobRef.current.url);
    };
  }, []);

  // The "image done" path. Called from <img onLoad> AND from the ref
  // callback below — the latter catches cache-instant hits where the
  // browser served the bytes synchronously (memory cache) and `complete`
  // is already true the moment the ref attaches. Without that, the very
  // first `<img>` render would still wait for an onLoad tick, giving a
  // perceptible white flash on every fullscreen open even when cached.
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

  // Ref callback (NOT an effect — safe to call setState here, runs after
  // layout, before paint). On mount or src change, if the image is already
  // complete from cache, mark loaded right away. Idempotent: setLoadedId
  // with the same value bails inside React.
  const handleImgRef = useCallback(
    (el: HTMLImageElement | null) => {
      imgRef.current = el;
      // ChordOverlay depends on the element identity to wire up its
      // ResizeObserver, so we mirror the ref into state for it. The setter
      // runs after layout (inside a ref callback), so it doesn't block
      // paint.
      setImgEl(el);
      if (
        el &&
        song &&
        el.complete &&
        el.naturalWidth > 0 &&
        loadedId !== song.id
      ) {
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

  // The global viewport meta in index.html sets user-scalable=no so the app
  // chrome doesn't accidentally zoom on iPad. But chord sheets NEED pinch-
  // zoom for legibility, so we temporarily swap the meta while fullscreen
  // is open and restore it on close.
  //
  // iOS quirk: if the user pinches in fullscreen, iOS preserves the zoom
  // level across viewport-meta changes — so restoring `user-scalable=no`
  // alone doesn't zoom out, and the list page ends up "stuck" zoomed, with
  // touch-drag panning instead of scrolling. The fix is to first force a
  // zoom-locked meta (`maximum-scale=1.0`, distinct from the original by
  // including `initial-scale=1.0`), which makes iOS re-evaluate and snap
  // back to 1.0, then put the original meta back so future fullscreen
  // opens still find their starting state.
  useEffect(() => {
    if (!song) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.content;
    meta.content =
      "width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=5.0, user-scalable=yes";
    return () => {
      meta.content =
        "width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no";
      // Restore in the next frame so iOS commits the zoom-reset first.
      requestAnimationFrame(() => {
        meta.content = original;
      });
    };
  }, [song]);

  // PWA standalone mode (iOS Add-to-Home-Screen, installed Chrome/Edge PWAs)
  // locks the viewport at scale=1 and ignores mid-page `user-scalable=yes`
  // meta changes — so on those installs we can't rely on the browser's
  // native pinch and run a custom CSS-transform handler instead. In regular
  // Safari / Chrome on iPhone / iPad, the viewport meta we set on open lets
  // iOS handle pinch natively, which is buttery in a way no JS fake can
  // match — so we yield to the browser by setting `touch-action: pinch-zoom`
  // and skipping the custom handler entirely.
  const isStandalone = useMemo(() => {
    if (typeof window === "undefined") return false;
    const navAny = window.navigator as Navigator & { standalone?: boolean };
    return (
      navAny.standalone === true ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(display-mode: standalone)").matches)
    );
  }, []);

  // Custom transform-based pinch / pan / double-tap — only wired up in PWA
  // standalone mode (see `isStandalone` above). Native touch events (not
  // Pointer Events) because iOS Safari's multi-touch via Pointer Events is
  // still flaky for simultaneous touches in PWAs — touchstart/move/end is
  // the boring path that always reports both fingers. `touch-action: none`
  // on the wrapper plus explicit preventDefault inside two-finger move
  // suppresses any residual browser pinch / double-tap zoom that would
  // otherwise compete with ours.
  useEffect(() => {
    if (!isStandalone) return;
    const el = zoomWrapRef.current;
    if (!el) return;

    type PinchStart = {
      dist: number;
      localCx: number;
      localCy: number;
      startScale: number;
    };
    let pinchStart: PinchStart | null = null;
    let panStart:
      | { x: number; y: number; tx: number; ty: number }
      | null = null;
    let lastTapAt = 0;
    let lastTapX = 0;
    let lastTapY = 0;

    const baseRect = () => {
      // Parent is the untransformed bg container; the wrapper itself reports
      // a transformed bounding rect, which would feed wrong center / size
      // values back into the pinch math.
      const parent = el.parentElement;
      return parent
        ? parent.getBoundingClientRect()
        : new DOMRect(0, 0, 0, 0);
    };

    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(Math.max(v, lo), hi);

    const clampPan = (tx: number, ty: number, scale: number) => {
      const b = baseRect();
      // At scale s, the wrapper visually extends s× its base size around its
      // center. Allowable translate is half of the overflow on each axis.
      const maxTx = (b.width * (scale - 1)) / 2;
      const maxTy = (b.height * (scale - 1)) / 2;
      return {
        tx: clamp(tx, -maxTx, maxTx),
        ty: clamp(ty, -maxTy, maxTy),
      };
    };

    // Map a screen point to the wrapper's untransformed local coordinates
    // (origin at the wrapper's geometric center is (b.width/2, b.height/2)).
    // We anchor on a local point so the pinch math is independent of where
    // the wrapper happens to be on screen after translation.
    const screenToLocal = (sx: number, sy: number) => {
      const b = baseRect();
      const z = zoomRef.current;
      const cx = b.width / 2;
      const cy = b.height / 2;
      return {
        x: cx + (sx - b.left - cx - z.tx) / z.scale,
        y: cy + (sy - b.top - cy - z.ty) / z.scale,
      };
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const a = e.touches[0];
        const c = e.touches[1];
        const dist = Math.hypot(a.clientX - c.clientX, a.clientY - c.clientY);
        const sx = (a.clientX + c.clientX) / 2;
        const sy = (a.clientY + c.clientY) / 2;
        const local = screenToLocal(sx, sy);
        pinchStart = {
          dist,
          localCx: local.x,
          localCy: local.y,
          startScale: zoomRef.current.scale,
        };
        panStart = null;
        lastTapAt = 0;
        return;
      }
      if (e.touches.length === 1) {
        const t = e.touches[0];
        const now = Date.now();
        // Double-tap toggles between 1× and 2.5× anchored on the tap point.
        // 280 ms / 28 px windows match what iOS uses for its own native
        // double-tap recognition, so users can't accidentally trigger a
        // single-tap action between two intended double-taps.
        if (
          now - lastTapAt < 280 &&
          Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) < 28
        ) {
          e.preventDefault();
          lastTapAt = 0;
          const z = zoomRef.current;
          if (z.scale > 1.05) {
            setZoom({ scale: 1, tx: 0, ty: 0, animate: true });
          } else {
            const b = baseRect();
            const scale = 2.5;
            const cx = b.left + b.width / 2;
            const cy = b.top + b.height / 2;
            // Keep (t.clientX, t.clientY) at the same screen position
            // after scaling around the center: tx = (1 - s) * (sx - cx).
            const tx = (1 - scale) * (t.clientX - cx);
            const ty = (1 - scale) * (t.clientY - cy);
            const cp = clampPan(tx, ty, scale);
            setZoom({ scale, tx: cp.tx, ty: cp.ty, animate: true });
          }
          return;
        }
        lastTapAt = now;
        lastTapX = t.clientX;
        lastTapY = t.clientY;
        const z = zoomRef.current;
        panStart =
          z.scale > 1
            ? { x: t.clientX, y: t.clientY, tx: z.tx, ty: z.ty }
            : null;
      }
    };

    const onMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStart) {
        e.preventDefault();
        const a = e.touches[0];
        const c = e.touches[1];
        const dist = Math.hypot(a.clientX - c.clientX, a.clientY - c.clientY);
        const sx = (a.clientX + c.clientX) / 2;
        const sy = (a.clientY + c.clientY) / 2;
        const scale = clamp(
          (pinchStart.startScale * dist) / pinchStart.dist,
          1,
          5,
        );
        const b = baseRect();
        // Forward equation: sx = b.left + b.width/2 + s*(localCx - b.width/2) + tx
        const tx =
          sx - b.left - b.width / 2 - scale * (pinchStart.localCx - b.width / 2);
        const ty =
          sy - b.top - b.height / 2 - scale * (pinchStart.localCy - b.height / 2);
        const cp = clampPan(tx, ty, scale);
        setZoom({ scale, tx: cp.tx, ty: cp.ty, animate: false });
        return;
      }
      if (e.touches.length === 1 && panStart) {
        e.preventDefault();
        const t = e.touches[0];
        const z = zoomRef.current;
        const tx = panStart.tx + (t.clientX - panStart.x);
        const ty = panStart.ty + (t.clientY - panStart.y);
        const cp = clampPan(tx, ty, z.scale);
        setZoom({ scale: z.scale, tx: cp.tx, ty: cp.ty, animate: false });
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        pinchStart = null;
        panStart = null;
        const z = zoomRef.current;
        // Snap fully back if user pinched out close to (or past) 1×. The
        // clamp keeps scale >= 1 during the gesture, but this rounds away
        // the tail-end animations and resets the translation cleanly.
        if (z.scale < 1.02) {
          setZoom({ scale: 1, tx: 0, ty: 0, animate: true });
        }
        return;
      }
      if (e.touches.length === 1 && pinchStart) {
        // One finger of a pinch lifted — convert the remaining finger into
        // a pan anchor so the user can keep dragging without re-tapping.
        pinchStart = null;
        const t = e.touches[0];
        const z = zoomRef.current;
        panStart =
          z.scale > 1
            ? { x: t.clientX, y: t.clientY, tx: z.tx, ty: z.ty }
            : null;
      }
    };

    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [setZoom, isStandalone]);

  if (!song) return null;

  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in flex-col bg-bg bg-page-grad">
      <header
        className="relative z-10 flex shrink-0 items-center gap-2 border-b border-white/[0.08] glass-strong px-3.5 py-2.5 text-white sm:gap-3 sm:px-5 sm:py-3"
        style={{ paddingTop: "calc(0.625rem + var(--safe-top))" }}
      >
        <div className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-brand-grad shadow-glow-sm ring-1 ring-white/10">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-b from-white/25 to-transparent"
          />
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className="relative size-[18px]"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
        <h2 className="min-w-0 flex-1 truncate font-display text-[17px] font-semibold leading-[1.4] tracking-tight sm:text-[20px] sm:leading-[1.4]">
          {song.name}
        </h2>
        {/* Mobile: tight `gap-1.5` makes the 3 controls read as one cohesive
            toolbar unit instead of three loose buttons. Desktop (`sm:contents`):
            wrapper dissolves so chip/invert/close become direct header children
            and pick up the header's gap-3 — original inline layout. */}
        <div className="flex shrink-0 items-center gap-1.5 sm:contents">
          <DetectionChip
            status={
              currentOcrError
                ? "error"
                : currentOcr
                ? "ready"
                : "loading"
            }
            fromKey={fromKey}
            toKey={toKey}
            detectedKey={currentOcr?.detectedKey ?? null}
            chordCount={
              currentOcr
                ? currentOcr.result.chords.reduce(
                    (n, c) => n + (c.sequence?.length ?? 1),
                    0,
                  )
                : 0
            }
            transposeActive={transposeActive}
            onChangeFrom={setFrom}
            onChangeTo={setTo}
            onReset={resetTranspose}
            ocrDebug={ocrDebug}
            onToggleOcrDebug={toggleOcrDebug}
          />
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
          {/* Close button is icon-only (X) on mobile so it matches the chip and
              invert button as a 9×9 square — a row of three same-height tap
              targets reads as one toolbar instead of three mismatched controls.
              Desktop reverts to the text button with its "ESC" hint, since
              horizontal room is plentiful and the shortcut is genuinely useful. */}
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

      {/* Image fills 100% of remaining area — no padding, no border, no
          rounded corners. `filter: invert(1)` flips white paper → black +
          black ink → white. The dark gutters (when aspect ratios differ)
          match the page bg seamlessly.

          Loading + error states keep this layer transparent so the outer
          wrapper's `bg-bg bg-page-grad` (matching the song-list page) shows
          through. Once the chord sheet decodes we paint the chord-paper
          white (or black in invert mode) underneath — and the swap is
          INSTANT, not a fade. Any easing here trails behind the image
          paint, so users see the image first and the gutter fades in
          afterwards. Flipping together is what reads as "just appeared". */}
      <div
        className={`relative min-h-0 flex-1 overflow-hidden ${
          loaded
            ? invertImages
              ? "bg-black"
              : "bg-white"
            : "bg-transparent"
        }`}
        style={{ paddingBottom: "var(--safe-bottom)" }}
        onClick={close}
      >
        {!loaded && !errored && (
          // Delayed via CSS animation rather than a setTimeout-driven state
          // — cache hits reach `loaded=true` before the 150 ms delay
          // elapses, so the indicator never paints. Slow loads cross the
          // threshold and fade in. Pure CSS, no extra state / re-renders.
          //
          // Mirrors the App-shell loader at [App.tsx](../App.tsx): brand-
          // grad rounded tile with a soft glowing halo + the play icon that
          // matches the header's brand mark, so the loading state reads as
          // a deliberate part of the design system instead of a transient
          // toast. The `pulse-glow` keyframe gives the "actively working"
          // signal; no spinning element needed.
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
                <svg
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="relative size-7 text-white"
                  aria-hidden="true"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <p className="font-display text-[14px] font-semibold tracking-[-0.005em] text-ink">
                กำลังเปิดเพลง
              </p>
              <p className="max-w-[280px] truncate text-[12px] text-ink-mute">
                {song.name}
              </p>
            </div>
          </div>
        )}
        {errored && (
          <ErrorOverlay
            online={online}
            onRetry={retry}
            onClose={close}
          />
        )}
        {/* Zoom/pan wrapper — both the <img> and the chord-text overlay
            live inside so they scale together as one unit. ChordOverlay
            positions itself off `imgEl.clientWidth/Height` (which are NOT
            affected by CSS transforms), so labels stay glued to chords
            through every pinch.

            PWA standalone: `touch-action: none` hands all gesture handling
            to the touch listeners in useEffect (which run only in this
            mode), and `willChange: transform` keeps the GPU compositor
            warm so pinch tracking stays jitter-free.

            Regular browser: `touch-action: pinch-zoom` lets iOS handle
            two-finger pinch natively via the viewport-meta we set on open.
            The transform / zoom state stays at identity (the custom
            handler doesn't run), so this becomes a passive wrapper that
            doesn't interfere with the browser's own zoom. */}
        <div
          ref={zoomWrapRef}
          className="relative h-full w-full"
          style={{
            transform: `translate3d(${zoom.tx}px, ${zoom.ty}px, 0) scale(${zoom.scale})`,
            transformOrigin: "center center",
            transition: zoom.animate
              ? "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)"
              : "none",
            touchAction: isStandalone ? "none" : "pinch-zoom",
            willChange: "transform",
          }}
        >
          <img
            // Bump the key on retry to force React to remount — same src
            // would otherwise re-serve the failed entry from the in-memory
            // image cache instead of re-fetching.
            key={`${song.id}-${retryToken}`}
            ref={handleImgRef}
            src={src}
            alt=""
            // VITE_IMAGE_BASE points at the R2 Custom Domain whose
            // Transform Rule returns `Access-Control-Allow-Origin: *`.
            // With this attribute the response is "cors" (not opaque) and
            // Chrome's opaque-padding tax stays off — without it every
            // cached image counts as ~7 MB toward quota regardless of its
            // real size, blowing past Safari's offline budget on the
            // first dozen entries.
            crossOrigin="anonymous"
            onLoad={() => {
              setLoadedId(song.id);
              // <img> loaded — but the SW's CacheFirst put() may or may not
              // have actually cached it (stale SW from a previous deploy,
              // pattern mismatch on cross-origin R2 URLs, etc). ensureCached
              // checks the cache directly and writes it ourselves via
              // cache.put if missing — guarantees the green offline-dot
              // turns on when it should, not "sometimes".
              ensureCached(song).then((ok) => {
                if (ok) notifyCacheChanged();
              });
            }}
            onError={() => setErrorId(song.id)}
            onClick={(e) => e.stopPropagation()}
            draggable={false}
            decoding="async"
            // No opacity hide / transition. The previous opacity-0 →
            // opacity-100 / 300 ms fade made every cached open feel like a
            // network load: the bytes were ready in ~30 ms but the user
            // saw 300 ms+ of white-with-fading-image. Browsers handle the
            // visual transition natively — they keep the previously-painted
            // contents until the new image is decoded, so removing the
            // forced opacity flip eliminates the white flash for cache hits
            // and doesn't introduce any "half-decoded image" flicker for
            // network loads (WebP at our quality is decoded all-at-once,
            // not progressively).
            className="block h-full w-full select-none object-contain"
            style={{
              // Plain invert — flips white paper → black + black ink → white.
              // No contrast/hue-rotate/saturation tweaks; those over-processed
              // the image and the user prefers the straight inversion.
              filter: invertImages ? "invert(1)" : undefined,
              imageRendering: "auto",
              // Hide the broken-image icon + alt text while the error
              // overlay is showing. Empty `alt=""` already suppresses the
              // text fallback in most browsers but the broken-image glyph
              // still paints — display:none kills both reliably.
              display: errored ? "none" : undefined,
            }}
          />
          {/* Transposed-chord overlay. Renders when OCR has finished AND
              either (a) the user has picked a non-identity (From, To), or
              (b) debug mode is on so the user can audit detection coverage.
              Sits above the image but below the panel + error overlay
              (which are z-10+). */}
          {currentOcr && (transposeActive || ocrDebug) && !errored && (
            <ChordOverlay
              result={currentOcr.result}
              imgEl={imgEl}
              fromKey={fromKey}
              toKey={toKey}
              invert={invertImages}
              debug={ocrDebug}
            />
          )}
        </div>
      </div>

    </div>
  );
}

const KEY_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;

const NOTE_SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"] as const;
const NOTE_FLAT  = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"] as const;
// Display name for a chosen key. Flats vs sharps follow the diatonic-chord
// convention table musicians read by (Db/Eb/Ab/Bb major print flats; D/E/A/B
// and F# major print sharps), so the chip/grid label stays in lockstep with
// the chord names rendered on the sheet.
function keyDisplay(k: number): string {
  return preferFlatsForKey(k) ? NOTE_FLAT[k] : NOTE_SHARP[k];
}
const POPOVER_WIDTH = 296;

// Tier thresholds calibrated against the diatonic-fit confidence scale —
// see [keyDetect.ts](../lib/keyDetect.ts). A fully diatonic chord chart
// scores 1.0; one borrowed chord drops it ~one slot; charts where less
// than half the detected chords fit the chosen scale are "low" and
// usually mean the OCR found garbage rather than music.
function confidenceTier(conf: number): "high" | "mid" | "low" {
  if (conf >= 0.85) return "high";
  if (conf >= 0.65) return "mid";
  return "low";
}

/**
 * Header-mounted detection chip + popover. The chip itself is a compact
 * single-line control showing the current source key (and target, when
 * transposed) plus a small status dot whose colour conveys OCR confidence
 * at a glance. Tapping the chip opens a small custom popover with the
 * 12-key target grid; an inline "คีย์เดิม" link toggles the same grid into
 * source-override mode without leaving the popover.
 *
 * The popover is rendered through `createPortal` to `document.body` so
 * that the header's `backdrop-filter: blur` doesn't establish a containing
 * block that would clip a `position: fixed` descendant on iOS Safari.
 * The popover's `left/top` are computed from the chip's
 * `getBoundingClientRect`, recomputed on resize / scroll so it stays
 * pinned across viewport changes (pinch-zoom, orientation flips).
 */
function DetectionChip({
  status,
  fromKey,
  toKey,
  detectedKey,
  chordCount,
  transposeActive,
  onChangeFrom,
  onChangeTo,
  onReset,
  ocrDebug,
  onToggleOcrDebug,
}: {
  status: "loading" | "ready" | "error";
  fromKey: number;
  toKey: number;
  detectedKey: KeyEstimate | null;
  chordCount: number;
  transposeActive: boolean;
  onChangeFrom: (v: number) => void;
  onChangeTo: (v: number) => void;
  onReset: () => void;
  ocrDebug: boolean;
  onToggleOcrDebug: () => void;
}) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Anchor the portal'd popover to the chip's live screen position. Both
  // resize and capture-phase scroll fire (capture so we catch scrolls in
  // nested containers, not just window).
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

  const isLoading = status === "loading";
  const isError = status === "error";
  const conf = detectedKey?.confidence ?? 0;
  const confPct = Math.round(conf * 100);
  const tier = confidenceTier(conf);
  const confLabel =
    tier === "high" ? "มั่นใจสูง" : tier === "mid" ? "ปานกลาง" : "ต่ำ";

  // Status-dot colour. Emerald/amber/rose read clearly on the glass-strong
  // header background in both light and dark chord-sheet modes.
  const dotClass = isError
    ? "bg-danger"
    : tier === "high"
    ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]"
    : tier === "mid"
    ? "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]"
    : "bg-rose-400 shadow-[0_0_6px_rgba(251,113,133,0.5)]";

  const closePopover = () => setOpen(false);
  const pickTo = (k: number) => {
    onChangeTo(k);
    closePopover();
  };
  // Picking a source key NEVER auto-closes — the musician is correcting
  // OCR's guess and almost certainly wants to pick a target next. Keeping
  // the popover open removes a frustrating "tap, close, re-open, tap"
  // dance when the auto-detect was off.
  const pickFrom = (k: number) => {
    onChangeFrom(k);
  };
  const handleReset = () => {
    onReset();
    closePopover();
  };

  return (
    <>
      <button
        ref={chipRef}
        onClick={() => !isLoading && setOpen((v) => !v)}
        disabled={isLoading}
        aria-label="เลือกคีย์"
        className={`relative flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-[12.5px] font-semibold tracking-tight shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] transition active:scale-95 ${
          isLoading
            ? "cursor-default border-white/10 bg-white/[0.04] text-white/50"
            : isError
            ? "border-danger/40 bg-danger/10 text-danger hover:bg-danger/15"
            : transposeActive
            ? "border-brand/45 bg-brand-soft text-brand hover:bg-brand/20"
            : "border-white/[0.12] bg-white/[0.06] text-white/90 hover:border-white/20 hover:bg-white/[0.12]"
        }`}
      >
        {isLoading ? (
          <>
            <span className="inline-block size-3 animate-spin rounded-full border-2 border-white/30 border-t-white/70" />
            <span className="hidden sm:inline">วิเคราะห์...</span>
          </>
        ) : (
          <>
            <span className={`inline-block size-2 rounded-full ${dotClass}`} aria-hidden="true" />
            <span className="tabular-nums">{keyDisplay(fromKey)}</span>
            {transposeActive && (
              <>
                <span className="opacity-50">→</span>
                <span className="tabular-nums">{keyDisplay(toKey)}</span>
              </>
            )}
            <ChevronDownIcon flip={open} />
          </>
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            {/* Outside-click capture layer. Sits below the popover so taps
                inside the popover never reach it. */}
            <div
              className="fixed inset-0 z-[60]"
              onClick={closePopover}
            />
            <div
              role="dialog"
              aria-label="เลือกคีย์"
              onClick={(e) => e.stopPropagation()}
              className="fixed z-[61] flex flex-col gap-2.5 rounded-2xl border border-white/10 bg-bg-soft/95 p-3 shadow-2xl backdrop-blur-xl animate-slide-up"
              style={{
                top: pos.top,
                left: pos.left,
                width: POPOVER_WIDTH,
              }}
            >
              {/* Analysis summary line — visible at the top so the user
                  always knows how much to trust the auto-detected source.
                  Errors swap in a redder message + invite manual input. */}
              {isError ? (
                <div className="text-[11.5px] leading-snug text-danger/90">
                  วิเคราะห์รูปไม่สำเร็จ — กรอกคีย์ต้นฉบับเอง
                </div>
              ) : (
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-ink-dim">
                    วิเคราะห์เจอ{" "}
                    <span className="font-semibold text-ink">{chordCount}</span>{" "}
                    คอร์ด
                  </span>
                  <span className="flex items-center gap-1.5 font-medium text-ink-dim">
                    <span className={`inline-block size-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
                    <span>
                      {confLabel} · {confPct}%
                    </span>
                  </span>
                </div>
              )}

              {/* SOURCE picker — the musician's manual override for OCR's
                  guess. Shown above the target picker so it reads as the
                  starting point of the transposition. Picking here keeps
                  the popover open; the user almost always follows up with
                  a target. */}
              <KeyGrid
                heading="คีย์ต้นฉบับ"
                hint={isError ? "ไม่มีการตรวจจับ — เลือกเอง" : "OCR เดาให้แล้ว · กดเพื่อแก้"}
                value={fromKey}
                onPick={pickFrom}
                accent="muted"
              />

              {/* TARGET picker — the user's "เปลี่ยนเป็นคีย์อะไร" choice.
                  Picking here applies the transpose and closes the popover. */}
              <KeyGrid
                heading="เปลี่ยนเป็น"
                hint="แตะคีย์ที่ต้องการ"
                value={toKey}
                onPick={pickTo}
                accent="brand"
              />

              {/* Debug toggle — outlines every chord OCR detected, so the
                  user can audit which chord positions were and weren't
                  caught (especially the Intro / Instru / Outro section
                  rows that historically had unreliable detection). Kept
                  in the popover instead of the main header so it doesn't
                  clutter the toolbar. */}
              <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
                <span className="text-[11px] font-medium text-ink-dim">
                  แสดงคอร์ดที่ตรวจเจอ (debug)
                </span>
                <button
                  onClick={onToggleOcrDebug}
                  role="switch"
                  aria-checked={ocrDebug}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${
                    ocrDebug ? "bg-brand" : "bg-white/15"
                  }`}
                >
                  <span
                    className={`inline-block size-4 transform rounded-full bg-white transition ${
                      ocrDebug ? "translate-x-[18px]" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>

              {transposeActive && (
                <div className="-mb-0.5 flex justify-end border-t border-white/[0.06] pt-2.5">
                  <button
                    onClick={handleReset}
                    className="text-[11px] font-medium text-ink-dim transition hover:text-danger"
                  >
                    ยกเลิกการเปลี่ยนคีย์
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

/**
 * One row of label/hint + a 6×2 grid of 12 pitch-class buttons. Shared
 * between the source and target pickers inside the transpose popover —
 * the only differences are the heading copy, the bound value, and the
 * accent (target gets the brand gradient on the active tile; source uses
 * a quieter outlined treatment so it doesn't compete visually with the
 * primary "เปลี่ยนเป็น" action).
 */
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
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
          {heading}
        </span>
        {hint && (
          <span className="text-[10.5px] text-ink-dim/70">{hint}</span>
        )}
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
              title={
                NOTE_FLAT[k] !== NOTE_SHARP[k]
                  ? `${NOTE_SHARP[k]} / ${NOTE_FLAT[k]}`
                  : NOTE_SHARP[k]
              }
              className={`flex h-9 items-center justify-center rounded-lg text-[13px] font-bold tabular-nums transition active:scale-95 ${
                active
                  ? activeClass
                  : "bg-white/[0.06] text-white/85 hover:bg-white/[0.12]"
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
    <svg
      viewBox="0 0 16 16"
      className={`size-3 opacity-70 transition-transform ${flip ? "rotate-180" : ""}`}
      aria-hidden="true"
    >
      <path
        d="m4 6 4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Shown in place of a broken `<img>` when the chord sheet fails to load —
 * usually offline + not yet cached, occasionally a transient network blip.
 * Matches the modal/empty-state aesthetic used elsewhere in the app
 * (brand-grad halo + soft brand-grad-soft pill + Display font heading).
 *
 * Stops click bubbling so tapping the card itself doesn't trigger the
 * backdrop's `onClick={close}` — only the explicit "ปิด" button closes.
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
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center px-6 text-center animate-fade-in"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="relative mb-6">
        <div
          aria-hidden
          className="absolute inset-0 -m-5 rounded-full bg-brand-grad opacity-25 blur-2xl"
        />
        <div className="relative grid size-20 place-items-center rounded-[26px] bg-brand-grad-soft ring-1 ring-brand/30 shadow-glow-sm">
          {online ? <CloudWarnIcon /> : <CloudOffIcon />}
        </div>
      </div>
      <h3 className="font-display text-[20px] font-semibold tracking-[-0.015em] text-ink sm:text-[22px]">
        {online ? "โหลดเพลงไม่สำเร็จ" : "อยู่ในโหมดออฟไลน์"}
      </h3>
      <p className="mt-2 max-w-xs text-[13.5px] leading-relaxed text-ink-dim sm:text-[14px]">
        {online
          ? "อาจเป็นสัญญาณห่วยชั่วคราว — ลองอีกครั้งดูนะ"
          : "เพลงนี้ยังไม่ถูกบันทึกลงเครื่อง เลยเปิดดูตอนนี้ไม่ได้"}
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
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-9 text-brand"
      aria-hidden="true"
    >
      <path d="m2 2 20 20" />
      <path d="M5.78 5.78A4 4 0 0 0 4 9a4 4 0 0 0 4 4h8" />
      <path d="M10.6 5.08A6 6 0 0 1 17 8a4 4 0 0 1 3 7" />
    </svg>
  );
}

function CloudWarnIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-9 text-brand"
      aria-hidden="true"
    >
      <path d="M17.5 19a4.5 4.5 0 1 0-4.42-5.36A6 6 0 1 0 7 19h10.5Z" />
      <path d="M12 9v3" />
      <circle cx="12" cy="15" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[16px]"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-[18px] ${className ?? ""}`}
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function ContrastIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden="true">
      {/* Outline of the full circle */}
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      {/* Filled left half — classic accessibility "invert colors" mark */}
      <path d="M 12 3 A 9 9 0 0 0 12 21 Z" fill="currentColor" />
    </svg>
  );
}

