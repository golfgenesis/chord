// Bulk download of chord-sheet images for offline use. Hands each URL to
// the service worker via a regular `fetch`; the SW's CacheFirst route then
// caches the response. When the device later goes offline the same cache
// serves the same URLs without a network round-trip.
//
// IMPORTANT: this requires the service worker to be active. In dev that
// means `devOptions.enabled: true` in vite.config.ts; in prod the SW
// registers automatically via vite-plugin-pwa.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Song } from "../types";
import { imageUrl } from "./imageUrl";

const CACHE_NAME = "chord-images";

// Adaptive concurrency tuning — start aggressive, back off on throttle.
// HTTP/2 same-origin handles ~32 streams comfortably; some flakey 4G
// connections only handle ~4. The pool resizes between these bounds.
// Initial size comes from the caller (OfflineSheet's CONCURRENCY); MIN
// and MAX are the floor/ceiling the adaptive loop will move between.
const MAX_BATCH = 64;
const MIN_BATCH = 4;
// Per-batch transient-failure ratio that triggers a halving.
const THROTTLE_RATIO = 0.25;
// Per-song retry budget for transient errors (5xx, network blip).
const MAX_RETRIES = 3;

export interface DownloadProgress {
  done: number;
  total: number;
  failed: number;
  /** Song ids that exhausted their retry budget — surface in the UI so the
   *  user can hit "retry failed" without re-walking the whole catalogue. */
  failedIds: number[];
  /** Currently-effective batch size. Useful for surfacing back-pressure
   *  ("network is slow — running at 4 parallel") to the user. */
  concurrency: number;
}

export interface StorageInfo {
  quota: number | null;
  usage: number | null;
  /** Bytes remaining before the browser starts evicting (best estimate). */
  available: number | null;
  /** True if the user has been granted persistent storage — the browser
   *  won't evict our cache when disk fills up. */
  persisted: boolean;
}

/**
 * Ask the browser to mark our storage persistent. Without this the chord-
 * image cache can be silently evicted when disk space runs low, throwing
 * away a 30-minute download. Requires a user-gesture context on most
 * browsers (so call it from a click handler).
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const persisted =
    navigator.storage?.persisted
      ? await navigator.storage.persisted().catch(() => false)
      : false;
  if (!navigator.storage?.estimate) {
    return { quota: null, usage: null, available: null, persisted };
  }
  try {
    const e = await navigator.storage.estimate();
    const quota = e.quota ?? null;
    const usage = e.usage ?? null;
    const available = quota !== null && usage !== null ? quota - usage : null;
    return { quota, usage, available, persisted };
  } catch {
    return { quota: null, usage: null, available: null, persisted };
  }
}

/**
 * Build a Set of every URL currently in the chord-image cache. One
 * `cache.keys()` call beats 70k individual `cache.match()` round-trips by
 * orders of magnitude — used both to fast-skip already-downloaded songs
 * and to display "ดาวน์โหลดแล้ว N เพลง" in the UI.
 */
export async function getCachedUrlSet(): Promise<Set<string>> {
  if (!("caches" in window)) return new Set();
  try {
    const cache = await caches.open(CACHE_NAME);
    const reqs = await cache.keys();
    const out = new Set<string>();
    for (const r of reqs) out.add(r.url);
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Resolve a song's URL to an absolute one so it can be compared against
 * the cache's key set (cache.keys() returns absolute URLs).
 */
export function absoluteImageUrl(song: Song): string {
  return new URL(imageUrl(song), window.location.href).href;
}

// "aborted" is distinct from "transient" so that hitting หยุด mid-batch
// doesn't pollute failedIds with songs that were just in-flight when the
// user paused. Those songs should be picked up by ดาวน์โหลดต่อ on the
// next run, not surfaced as "16 เพลงโหลดไม่สำเร็จ" with a retry button.
type DownloadResult = "ok" | "permanent" | "transient" | "aborted";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(id);
      reject(new DOMException("aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Fetch one image, cache it directly via `cache.put()`, and report back what
 * happened. We deliberately bypass the SW route by writing the response
 * ourselves — that way we don't depend on the SW being active/healthy, and
 * the cache key is guaranteed to match what the next `getCachedUrlSet()`
 * sees (which is how the "ดาวน์โหลดแล้ว N" counter is computed).
 *
 * Result semantics:
 *   - "ok"         — cached successfully
 *   - "permanent"  — 404: source doesn't have this image, retry won't help
 *   - "transient"  — 429/5xx/network/quota: caller should consider retry
 */
async function downloadOne(
  cache: Cache,
  song: Song,
  signal: AbortSignal,
): Promise<DownloadResult> {
  const url = imageUrl(song);
  let lastErr: unknown;
  // Track "has this song failed at least once for a real reason (not
  // abort)?" — so if the user pauses mid-retry, we don't pretend the
  // song was just in-flight. Songs that have already had a real failure
  // get "transient" on abort (→ failedIds → ลองโหลดใหม่ band) instead
  // of "aborted" (→ silently dropped).
  let hadFailure = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) return hadFailure ? "transient" : "aborted";
    try {
      // Default cors mode. VITE_IMAGE_BASE points at the R2 Custom
      // Domain whose Transform Rule returns Access-Control-Allow-Origin
      // — response is "cors" (not opaque), no Chrome padding tax.
      const res = await fetch(url, { signal });
      if (res.ok) {
        try {
          await cache.put(url, res);
          // Defensive post-write verify. cache.put has been observed to
          // resolve silently on Safari/iOS under quota pressure without
          // persisting — and on Firefox very rarely under heavy parallel
          // writes. One cache.match here turns "thought we cached" into
          // "know we cached" so the done counter never lies about state.
          const stored = await cache.match(url);
          if (!stored) {
            lastErr = "cache.put silently dropped entry";
            hadFailure = true;
          } else {
            return "ok";
          }
        } catch (e) {
          // Quota exhaustion shows up here as QuotaExceededError. Body
          // is consumed by the failed put, so we can't retry without a
          // fresh fetch — count as transient and let the batch logic
          // throttle down.
          lastErr = e;
          hadFailure = true;
        }
      } else if (res.status === 404) {
        return "permanent";
      } else {
        // 429, 503, etc — transient
        lastErr = res.status;
        hadFailure = true;
      }
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        return hadFailure ? "transient" : "aborted";
      }
      // Network/CORS/TypeError — counts as a real failure
      lastErr = e;
      hadFailure = true;
    }
    // Exponential backoff with a small jitter to spread retries out.
    if (attempt < MAX_RETRIES) {
      const delay = 500 * Math.pow(2, attempt) + Math.random() * 250;
      try {
        await sleep(delay, signal);
      } catch {
        return hadFailure ? "transient" : "aborted";
      }
    }
  }
  void lastErr; // last seen but not surfaced — failedIds carries which song
  return "transient";
}

/**
 * Concurrent bulk-download with an ADAPTIVE batch size. Skips songs that
 * are already cached, calls `onProgress` after each batch finishes, and
 * aborts immediately if the caller calls `signal.abort()`.
 *
 * Per-song failures are split into permanent (404) vs transient (5xx,
 * network blip, quota). Transients get up to MAX_RETRIES retries inside
 * `downloadOne`; if even that fails, the song id lands in `failedIds` so
 * the UI can offer a "retry failed" button instead of re-walking 70k
 * entries.
 *
 * Adaptive logic: after each batch, if >THROTTLE_RATIO of slots came back
 * transient, the batch halves (down to MIN_BATCH) and the next iteration
 * sleeps 2 s — the network or origin is struggling, back off. If no
 * transients and we're below the initial size, ramp back up.
 */
export async function downloadAllSongs(
  songs: Song[],
  initialConcurrency: number,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<DownloadProgress> {
  const cache = await caches.open(CACHE_NAME);
  const cachedKeys = await getCachedUrlSet();
  const queue: Song[] = [];
  for (const s of songs) {
    if (!cachedKeys.has(absoluteImageUrl(s))) queue.push(s);
  }

  const total = songs.length;
  let done = songs.length - queue.length;
  let failed = 0;
  const failedIds = new Set<number>();
  let batchSize = Math.min(MAX_BATCH, Math.max(MIN_BATCH, initialConcurrency));

  const snapshot = (): DownloadProgress => ({
    done,
    total,
    failed,
    failedIds: Array.from(failedIds),
    concurrency: batchSize,
  });

  onProgress(snapshot());

  while (queue.length && !signal.aborted) {
    const batch = queue.splice(0, batchSize);
    const results = await Promise.all(
      batch.map((song) => downloadOne(cache, song, signal)),
    );
    let throttled = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const song = batch[i];
      if (r === "ok") {
        done++;
      } else if (r === "permanent") {
        failed++;
        failedIds.add(song.id);
      } else if (r === "transient") {
        // Exhausted retries on a real network/server error. Surface to
        // UI so the user can pick up later (network coming back, quota
        // freed, etc.) and count towards adaptive back-off.
        failed++;
        failedIds.add(song.id);
        throttled++;
      }
      // r === "aborted" → user hit หยุด mid-flight. Not a failure; the
      // song just didn't run. Skip silently — ดาวน์โหลดต่อ will pick it
      // up on the next run via the cache-miss queue.
    }
    // Adaptive resize.
    if (throttled / batch.length > THROTTLE_RATIO && batchSize > MIN_BATCH) {
      batchSize = Math.max(MIN_BATCH, Math.floor(batchSize / 2));
      onProgress(snapshot());
      // Brief pause so we don't immediately hammer the origin again.
      try {
        await sleep(2000, signal);
      } catch {
        break;
      }
    } else if (throttled === 0 && batchSize < initialConcurrency) {
      batchSize = Math.min(initialConcurrency, batchSize + 4);
      onProgress(snapshot());
    } else {
      onProgress(snapshot());
    }
  }

  // Bulk-download just wrote a bunch of entries — let subscribers (badges,
  // SongList "offline" dots) refresh without waiting for their next tick.
  notifyCacheChanged();

  // Final reconcile against the real cache state. Catches:
  //   - Eviction during the run (browser dropped older entries while we
  //     were adding newer ones because persistent storage wasn't granted)
  //   - Per-put verify drift (the verify is best-effort under timeouts;
  //     a key that snuck through but later got evicted shows up here)
  // Only reconcile if the run completed naturally — when the user aborts,
  // the un-walked tail is "not started", not "failed", and shouldn't get
  // surfaced in the retry list.
  if (!signal.aborted) {
    const finalCached = await getCachedUrlSet();
    const realDone: number[] = [];
    const realFailed: number[] = [];
    for (const s of songs) {
      if (finalCached.has(absoluteImageUrl(s))) realDone.push(s.id);
      else realFailed.push(s.id);
    }
    done = realDone.length;
    failed = realFailed.length;
    failedIds.clear();
    for (const id of realFailed) failedIds.add(id);
  }

  return snapshot();
}

/**
 * Defensive single-song cache. The Fullscreen viewer relies on the SW's
 * CacheFirst route to cache images it loads via `<img src>`, but on a
 * stale SW (or any device where the route pattern doesn't match — see
 * sw.ts IMAGE_BASE logic) that caching silently doesn't happen and the
 * green offline-available dot never appears.
 *
 * This function checks the cache directly; if the entry is missing it
 * fetches and `cache.put`s it itself, with the same post-write verify
 * the bulk-download path uses. Cheap when the SW is healthy (one
 * `cache.match` only), reliable when the SW isn't.
 */
export async function ensureCached(song: Song): Promise<boolean> {
  if (!("caches" in window)) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    const url = imageUrl(song);
    const existing = await cache.match(url);
    if (existing) return true;
    const res = await fetch(url);
    if (!res.ok) return false;
    await cache.put(url, res);
    const stored = await cache.match(url);
    return Boolean(stored);
  } catch {
    return false;
  }
}

/**
 * Audit the cache against a list of songs and report what's actually
 * stored vs what's missing. The progress counter is best-effort; this
 * function is the source of truth for "is song X available offline?".
 *
 * Use cases:
 *   - Manual "verify" button — user wants to confirm what they have
 *   - End of a download run (we already call this internally)
 *   - Pre-flight before a long offline session (e.g. a gig)
 */
export async function verifyCache(songs: Song[]): Promise<{
  cached: Song[];
  missing: Song[];
}> {
  const cachedSet = await getCachedUrlSet();
  const cached: Song[] = [];
  const missing: Song[] = [];
  for (const s of songs) {
    (cachedSet.has(absoluteImageUrl(s)) ? cached : missing).push(s);
  }
  return { cached, missing };
}

/**
 * Retry just the songs whose ids landed in `failedIds`. Reuses the same
 * adaptive batch logic; transient failures still get full retries within
 * each call. Useful when the user comes back from an offline period and
 * wants to mop up what didn't make it the first time.
 */
export async function retryFailed(
  songs: Song[],
  failedIds: number[],
  concurrency: number,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<DownloadProgress> {
  const idSet = new Set(failedIds);
  const subset = songs.filter((s) => idSet.has(s.id));
  return downloadAllSongs(subset, concurrency, onProgress, signal);
}

// ─── Cache change pub/sub ────────────────────────────────────────────────
//
// The chord-image Cache Storage has no native change event. Anything that
// mutates it (a Fullscreen image load that just got SW-cached, an explicit
// clearImageCache, a one-off fetch) has to call notifyCacheChanged() so
// every subscriber re-scans cache.keys() and updates its derived state.
// Without this, the green "offline-available" dot in SongList stays stale
// after the user views a song, and the "downloaded N เพลง" tally in
// OfflineSheet doesn't fall to 0 after Clear Cache.

let cacheVersion = 0;
const cacheChangeListeners = new Set<() => void>();

export function subscribeCacheChange(listener: () => void): () => void {
  cacheChangeListeners.add(listener);
  return () => {
    cacheChangeListeners.delete(listener);
  };
}

export function getCacheVersion(): number {
  return cacheVersion;
}

export function notifyCacheChanged(): void {
  cacheVersion++;
  for (const l of cacheChangeListeners) l();
}

// ─── Singleton download manager ──────────────────────────────────────────
//
// The OfflineSheet modal mounts and unmounts as the user opens/closes it,
// so React-local state (`useState`) would reset to `progress=null` every
// time they reopen — even mid-download. Keeping the download's progress
// and AbortController at module scope (and exposing them through a
// useSyncExternalStore subscription) lets the modal disappear without
// affecting the in-flight work. When the user reopens the sheet they see
// "52 / 70,107" right where it was, not 0%.

export interface DownloadManagerState {
  isDownloading: boolean;
  progress: DownloadProgress | null;
}

let managerState: DownloadManagerState = {
  isDownloading: false,
  progress: null,
};
let currentController: AbortController | null = null;
const listeners = new Set<() => void>();

function setManagerState(patch: Partial<DownloadManagerState>) {
  managerState = { ...managerState, ...patch };
  for (const l of listeners) l();
}

export function subscribeDownload(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDownloadState(): DownloadManagerState {
  return managerState;
}

/**
 * Start (or no-op if already running) a bulk-download of the given songs.
 * Returns the final progress, or `null` if a download was already in
 * flight. Cleans up `isDownloading` automatically on completion or abort.
 */
export async function startBulkDownload(
  songs: Song[],
  concurrency: number,
): Promise<DownloadProgress | null> {
  if (managerState.isDownloading) return null;
  const ctrl = new AbortController();
  currentController = ctrl;
  setManagerState({
    isDownloading: true,
    progress: {
      done: 0,
      total: songs.length,
      failed: 0,
      failedIds: [],
      concurrency,
    },
  });
  try {
    const finalProgress = await downloadAllSongs(
      songs,
      concurrency,
      (p) => setManagerState({ progress: p }),
      ctrl.signal,
    );
    setManagerState({ progress: finalProgress });
    return finalProgress;
  } finally {
    setManagerState({ isDownloading: false });
    if (currentController === ctrl) currentController = null;
  }
}

/**
 * Start (or no-op if already running) a retry pass over a specific set of
 * song ids. Same singleton/abort plumbing as startBulkDownload — the
 * modal can close, reopen, and the retry keeps running in the background.
 */
export async function startRetryFailed(
  songs: Song[],
  failedIds: number[],
  concurrency: number,
): Promise<DownloadProgress | null> {
  if (managerState.isDownloading) return null;
  const ctrl = new AbortController();
  currentController = ctrl;
  setManagerState({
    isDownloading: true,
    progress: {
      done: 0,
      total: failedIds.length,
      failed: 0,
      failedIds: [],
      concurrency,
    },
  });
  try {
    const finalProgress = await retryFailed(
      songs,
      failedIds,
      concurrency,
      (p) => setManagerState({ progress: p }),
      ctrl.signal,
    );
    setManagerState({ progress: finalProgress });
    return finalProgress;
  } finally {
    setManagerState({ isDownloading: false });
    if (currentController === ctrl) currentController = null;
  }
}

export function abortBulkDownload(): void {
  currentController?.abort();
}

/**
 * Wipe the entire chord-image cache. Used by the "clear cache" button in
 * the offline-mode sheet — gives the user a way to reclaim the GBs the
 * pre-cache consumed without having to use the browser's settings UI.
 *
 * Aborts any in-flight bulk download first so the abortion handler can
 * unwind cleanly (otherwise workers keep adding to the cache while we
 * clear it from underneath them and the storage usage stays misleading).
 */
export async function clearImageCache(): Promise<boolean> {
  abortBulkDownload();
  // Tiny pause so the workers actually observe the abort signal before
  // we drop the cache out from under them — otherwise some "in flight"
  // fetches finish after `caches.delete` and re-add entries.
  await new Promise((r) => setTimeout(r, 100));
  if (!("caches" in window)) return false;
  try {
    const ok = await caches.delete(CACHE_NAME);
    setManagerState({ progress: null });
    notifyCacheChanged();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Returns a Set of `song.id`s whose image is currently in the offline
 * cache. Subscribes to the bulk-download manager so badges update as the
 * download progresses; uses an interval poll while download is running
 * because progress fires too rapidly to recompute every tick. When idle
 * (no download in flight), refreshes only on mount + when songs/viewing
 * change — single-view caches get picked up on the next interaction.
 */
export function useCachedSongIds(songs: Song[]): Set<number> {
  const [cached, setCached] = useState<Set<number>>(() => new Set());
  const dl = useSyncExternalStore(subscribeDownload, getDownloadState);
  // Re-scan whenever something explicitly tells us the cache changed
  // (Fullscreen image load, clearImageCache, etc.) — Cache Storage has
  // no native change event so notifyCacheChanged() is the trigger.
  const cv = useSyncExternalStore(subscribeCacheChange, getCacheVersion);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      if (songs.length === 0) return;
      const urlSet = await getCachedUrlSet();
      if (cancelled) return;
      const ids = new Set<number>();
      for (const s of songs) {
        if (urlSet.has(absoluteImageUrl(s))) ids.add(s.id);
      }
      if (!cancelled) setCached(ids);
    }
    refresh();
    if (dl.isDownloading) {
      const id = window.setInterval(refresh, 2000);
      return () => {
        cancelled = true;
        window.clearInterval(id);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [songs, dl.isDownloading, cv]);

  return cached;
}

export function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
