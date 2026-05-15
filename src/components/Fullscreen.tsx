import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { imageUrl } from "../lib/imageUrl";
import {
  ensureCached,
  getCachedImageBlobUrl,
  notifyCacheChanged,
} from "../lib/offlineDownload";

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

  if (!song) return null;

  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in flex-col bg-black">
      <header
        className="relative z-10 flex shrink-0 items-center gap-3 border-b border-white/[0.08] glass-strong px-4 py-2.5 text-white sm:px-5 sm:py-3"
        style={{ paddingTop: "calc(0.625rem + var(--safe-top))" }}
      >
        <div className="relative grid size-9 place-items-center rounded-xl bg-brand-grad shadow-glow-sm ring-1 ring-white/10">
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
        <h2 className="min-w-0 flex-1 truncate font-display text-[17px] font-semibold leading-[1.5] tracking-tight sm:text-[20px] sm:leading-[1.4]">
          {song.name}
        </h2>
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
          className="rounded-xl border border-white/[0.12] bg-white/[0.06] px-3.5 py-2 text-[14px] font-semibold tracking-[-0.005em] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] transition hover:border-white/20 hover:bg-white/[0.12] active:scale-95"
          aria-label="Close"
        >
          ย้อนกลับ
          <span className="ml-2 hidden text-white/40 sm:inline">ESC</span>
        </button>
      </header>

      {/* Image fills 100% of remaining area — no padding, no border, no
          rounded corners. `filter: invert(1) hue-rotate(180deg)` flips white
          paper → black + black ink → white, while preserving any color
          highlights in the chord notation. The dark gutters (when aspect
          ratios differ) match the page bg seamlessly. */}
      <div
        className={`relative min-h-0 flex-1 transition-colors duration-200 ${
          // When the load fails we swap to the app's dark surface so the
          // error card lives on a brand-matching background instead of
          // a stark chord-sheet white (or invert-mode black) gutter.
          errored
            ? "bg-bg"
            : invertImages
              ? "bg-black"
              : "bg-white"
        }`}
        style={{ paddingBottom: "var(--safe-bottom)" }}
        onClick={close}
      >
        {!loaded && !errored && (
          // Delayed via CSS animation rather than a setTimeout-driven state
          // — cache hits reach `loaded=true` before the 150 ms delay
          // elapses, so the spinner never paints. Slow loads cross the
          // threshold and fade in. Pure CSS, no extra state / re-renders.
          //
          // Spinner sits inside its own dark pill so it stays visible on
          // BOTH the white (normal) and black (invertImages) chord-sheet
          // backgrounds. Previously this used `text-white/70` directly on
          // the bg-white container — invisible white-on-white text was
          // the entire reason users said "เปิดแล้วเจอหน้าขาว 2 วิ" even
          // when the spinner was technically active.
          <div className="spinner-delayed pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex items-center gap-2.5 rounded-full bg-black/55 px-4 py-2 text-white/85 backdrop-blur-sm">
              <Spinner />
              <span className="text-[13px] font-medium">กำลังโหลด...</span>
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
      </div>
    </div>
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

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 animate-spin">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
        opacity="0.2"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
