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
import { isIOS } from "./platform";

const CACHE_NAME = "chord-images";

// Adaptive concurrency tuning — start with a sensible default, back off on
// throttle, ramp back up when the network steadies. The pool resizes
// between MIN and MAX. Defaults differ by platform: iOS Safari handles
// fewer concurrent HTTP/2 streams cleanly and background-throttles tabs
// aggressively (a single hung stream stalls the whole pool), so we keep
// the ceiling low. Desktop Chrome / non-iOS browsers comfortably handle
// 16+.
const MAX_WORKERS = 32;
const MIN_WORKERS = 2;
const IOS_DEFAULT_WORKERS = 6;
const NON_IOS_DEFAULT_WORKERS = 16;

/**
 * Suggested initial pool size for the device we're running on. Returned
 * value is a CEILING — the adaptive loop will halve under transient
 * failure and climb back up to this value when traffic settles.
 */
export function getRecommendedConcurrency(): number {
  return isIOS() ? IOS_DEFAULT_WORKERS : NON_IOS_DEFAULT_WORKERS;
}

// Per-fetch deadline. The single largest source of "stuck at N / 70,107"
// on iPad Safari: backgrounded tabs (jock screen off, swipe to another
// app, even just scrolling a long list for too long) freeze in-flight
// fetches without aborting or erroring. Without a timeout each frozen
// fetch is a permanent stall. 20s is generous for an actual image
// download over 4G (median is ~1s) but short enough that the pool
// recovers in seconds, not forever.
const FETCH_TIMEOUT_MS = 20_000;
// Rolling window for throttle ratio. Smaller window = more reactive,
// larger = more stable. 16 is small enough that one bad batch flips us
// to MIN_WORKERS within seconds.
const THROTTLE_WINDOW = 16;
// Transient-failure ratio inside the rolling window that triggers a
// halving.
const THROTTLE_RATIO = 0.25;
// Per-song retry budget for transient errors (5xx, network blip, timeout).
const MAX_RETRIES = 3;
// Progress callback rate-limit. Without this the singleton state churns
// React re-renders every few ms, which on iPad with the modal's
// backdrop-blur tanks the UI thread.
const PROGRESS_THROTTLE_MS = 200;

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

type FetchOutcome =
  | { kind: "ok"; res: Response }
  | { kind: "abort" }
  | { kind: "timeout" }
  | { kind: "error"; error: unknown };

/**
 * fetch() wrapped with a hard deadline. Without this on iPad Safari, a
 * single backgrounded/frozen connection holds a Promise that never settles
 * and the whole download appears stuck. Returns a tagged result so the
 * caller can tell user-abort apart from timeout (timeout → retry/transient,
 * abort → bail).
 */
async function fetchWithTimeout(
  url: string,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<FetchOutcome> {
  if (parentSignal.aborted) return { kind: "abort" };
  const ctrl = new AbortController();
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onParentAbort = () => ctrl.abort();
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { kind: "ok", res };
  } catch (e) {
    if (timedOut) return { kind: "timeout" };
    if (parentSignal.aborted) return { kind: "abort" };
    return { kind: "error", error: e };
  } finally {
    window.clearTimeout(timeoutId);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

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
  // Track "has this song failed at least once for a real reason (not
  // abort)?" — so if the user pauses mid-retry, we don't pretend the
  // song was just in-flight. Songs that have already had a real failure
  // get "transient" on abort (→ failedIds → ลองโหลดใหม่ band) instead
  // of "aborted" (→ silently dropped).
  let hadFailure = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) return hadFailure ? "transient" : "aborted";
    // Default cors mode. VITE_IMAGE_BASE points at the R2 Custom Domain
    // whose Transform Rule returns Access-Control-Allow-Origin — response
    // is "cors" (not opaque), no Chrome padding tax. Wrapped in a hard
    // timeout: backgrounded Safari tabs freeze fetches without aborting
    // and the un-timed version would stall the worker forever.
    const outcome = await fetchWithTimeout(url, signal, FETCH_TIMEOUT_MS);
    if (outcome.kind === "abort") return hadFailure ? "transient" : "aborted";
    if (outcome.kind === "ok") {
      const res = outcome.res;
      if (res.status === 404) return "permanent";
      if (res.ok) {
        try {
          await cache.put(url, res);
          // Defensive post-write verify. cache.put has been observed to
          // resolve silently on Safari/iOS under quota pressure without
          // persisting — and on Firefox very rarely under heavy parallel
          // writes. One cache.match here turns "thought we cached" into
          // "know we cached" so the done counter never lies about state.
          // ignoreVary because the stored response carries `Vary: Origin`
          // from the R2 Transform Rule (see sw.ts comment).
          const stored = await cache.match(url, { ignoreVary: true });
          if (stored) return "ok";
          hadFailure = true;
        } catch {
          // Quota exhaustion shows up here as QuotaExceededError. Body is
          // consumed by the failed put, so we can't retry without a fresh
          // fetch — count as transient and let the pool throttle down.
          hadFailure = true;
        }
      } else {
        // 429, 503, etc — transient
        hadFailure = true;
      }
    } else {
      // timeout or network/CORS/TypeError — transient
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
  return "transient";
}

/**
 * Concurrent bulk-download backed by a PROMISE POOL with adaptive sizing.
 * Skips already-cached songs, calls `onProgress` (throttled to ~200ms) as
 * work flows, and aborts immediately when `signal.abort()` fires.
 *
 * Pool vs batch — the previous implementation awaited Promise.all on each
 * batch of N fetches, which meant one frozen fetch held the entire batch
 * hostage (Safari iPad's #1 stall mode). With a pool, each worker pulls
 * its next song independently the moment its previous one settles, so a
 * single slow fetch can't block the rest.
 *
 * Per-song failures split into permanent (404) vs transient (5xx, network
 * blip, timeout, quota). Transients get MAX_RETRIES retries inside
 * `downloadOne`; survivors land in `failedIds` for the retry-failed band.
 *
 * Adaptive resize — a rolling window (THROTTLE_WINDOW results) tracks the
 * transient ratio. Above THROTTLE_RATIO → halve the active worker cap
 * (down to MIN_WORKERS). Zero transients with cap below the initial
 * value → ramp back by +2.
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
  let done = total - queue.length;
  let failed = 0;
  const failedIds = new Set<number>();
  const initial = Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, initialConcurrency));
  let cap = initial;
  // Rolling window of recent results — drives adaptive sizing.
  const recent: DownloadResult[] = [];

  const snapshot = (): DownloadProgress => ({
    done,
    total,
    failed,
    failedIds: Array.from(failedIds),
    concurrency: cap,
  });

  // Throttle onProgress so React isn't re-rendering 32×/sec when fetches
  // come back fast. We always force a tick on cap change and on the final
  // settlement.
  let lastTick = 0;
  let pendingTick: number | null = null;
  function emitProgress(force = false) {
    const now = Date.now();
    if (force || now - lastTick >= PROGRESS_THROTTLE_MS) {
      if (pendingTick !== null) {
        window.clearTimeout(pendingTick);
        pendingTick = null;
      }
      lastTick = now;
      onProgress(snapshot());
    } else if (pendingTick === null) {
      const wait = PROGRESS_THROTTLE_MS - (now - lastTick);
      pendingTick = window.setTimeout(() => {
        pendingTick = null;
        lastTick = Date.now();
        onProgress(snapshot());
      }, wait);
    }
  }

  emitProgress(true);

  let head = 0;
  let inflight = 0;
  let resolveDone: () => void;
  const done$ = new Promise<void>((r) => {
    resolveDone = r;
  });

  function maybeFinish() {
    if ((head >= queue.length || signal.aborted) && inflight === 0) {
      resolveDone();
    }
  }

  function recordResult(song: Song, result: DownloadResult) {
    recent.push(result);
    if (recent.length > THROTTLE_WINDOW) recent.shift();

    if (result === "ok") {
      done++;
    } else if (result === "permanent") {
      failed++;
      failedIds.add(song.id);
    } else if (result === "transient") {
      failed++;
      failedIds.add(song.id);
    }
    // "aborted" → user hit หยุด mid-flight. Not a failure; the song just
    // didn't run. Skip silently — ดาวน์โหลดต่อ picks it up on the next run.

    // Adaptive resize once we have a full window of data.
    if (recent.length >= THROTTLE_WINDOW) {
      let transients = 0;
      for (const r of recent) if (r === "transient") transients++;
      const ratio = transients / recent.length;
      if (ratio > THROTTLE_RATIO && cap > MIN_WORKERS) {
        cap = Math.max(MIN_WORKERS, Math.floor(cap / 2));
        recent.length = 0; // reset window after resize so we don't keep halving
        emitProgress(true);
      } else if (ratio === 0 && cap < initial) {
        cap = Math.min(initial, cap + 2);
        recent.length = 0;
        emitProgress(true);
      }
    }
    emitProgress();
  }

  function pump() {
    // Top up workers to current cap. Called after each completion AND on
    // initial spawn. When cap shrinks, this naturally stops spawning;
    // when it grows, the next completion's pump picks up the slack.
    while (
      inflight < cap &&
      head < queue.length &&
      !signal.aborted
    ) {
      const song = queue[head++];
      inflight++;
      downloadOne(cache, song, signal).then(
        (result) => {
          inflight--;
          recordResult(song, result);
          if (signal.aborted) {
            maybeFinish();
          } else {
            pump();
          }
        },
        () => {
          // downloadOne shouldn't throw, but be defensive — treat as
          // transient so it lands in failedIds, not a swallowed error.
          inflight--;
          recordResult(song, "transient");
          if (signal.aborted) {
            maybeFinish();
          } else {
            pump();
          }
        },
      );
    }
    maybeFinish();
  }

  // Abort fast-path — if the user hits หยุด, stop spawning new work and
  // resolve as soon as in-flight workers drain. The hard fetch timeout
  // (FETCH_TIMEOUT_MS) bounds the worst-case drain time; in practice
  // fetch's own AbortSignal makes it instant.
  const onAbort = () => {
    emitProgress(true);
    maybeFinish();
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  pump();
  await done$;
  signal.removeEventListener("abort", onAbort);
  if (pendingTick !== null) {
    window.clearTimeout(pendingTick);
    pendingTick = null;
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

  emitProgress(true);
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
    // ignoreVary because the stored response carries `Vary: Origin`
    // from the R2 Transform Rule (see sw.ts).
    const existing = await cache.match(url, { ignoreVary: true });
    if (existing) return true;
    // Same hard deadline as the bulk path — without this an iPad Safari
    // tab going background mid-load means ensureCached hangs forever and
    // the green offline-dot never resolves either way.
    const ctrl = new AbortController();
    const timeoutId = window.setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return false;
      await cache.put(url, res);
      const stored = await cache.match(url, { ignoreVary: true });
      return Boolean(stored);
    } finally {
      window.clearTimeout(timeoutId);
    }
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
